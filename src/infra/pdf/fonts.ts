import { Encodings, Font as StdFont, FontNames } from '@pdf-lib/standard-fonts';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFContext } from 'pdf-lib';
import { codeLength, lookupCid, parseCMap, type CMap, type CodeRange } from './cmap';
import { arrayNumbers, dictGet, getArray, getDict, getName, getNumber, N, resolve, streamBytes } from './objects';

// PDF のフォントを読み、文字列のバイト列を「1文字ずつのコード・Unicode・幅」に分ける（Issue #9）。
// 幅は文字空間の 1/1000 単位（Type3 は FontMatrix で換算済み）。
// 読めないフォントは supported=false とし、その文字は検査できないものとして扱う。

export type Glyph = {
  /** 文字列の中のバイト位置 [start, end) */
  start: number;
  end: number;
  code: number;
  /** 読めなければ null */
  unicode: string | null;
  /** 1/1000 単位の送り幅。分からなければ NaN */
  width: number;
  /** 1バイトのコード 32（語間 Tw が効く） */
  wordSpace: boolean;
};

export type FontInfo = {
  /** フォント辞書の参照。直接書かれた辞書なら undefined */
  ref?: PDFRef;
  subtype: string;
  baseFont: string;
  vertical: boolean;
  supported: boolean;
  reason?: string;
  decode(bytes: Uint8Array): Glyph[];
};

// ---- 標準の符号化と字形名 ----

type CodeTable = Map<number, { name: string; unicode: string }>;

function tableFor(enc: (typeof Encodings)[keyof typeof Encodings]): CodeTable {
  const t: CodeTable = new Map();
  for (const cp of enc.supportedCodePoints) {
    const { code, name } = enc.encodeUnicodeCodePoint(cp);
    if (!t.has(code)) t.set(code, { name, unicode: String.fromCodePoint(cp) });
  }
  return t;
}

let winAnsi: CodeTable | undefined;
let nameToUnicode: Map<string, string> | undefined;
const winAnsiTable = () => (winAnsi ??= tableFor(Encodings.WinAnsi));

function glyphNameToUnicode(name: string): string | null {
  if (!nameToUnicode) {
    nameToUnicode = new Map();
    for (const enc of [Encodings.WinAnsi, Encodings.Symbol, Encodings.ZapfDingbats]) {
      for (const { name: n, unicode } of tableFor(enc).values()) if (!nameToUnicode.has(n)) nameToUnicode.set(n, unicode);
    }
  }
  const known = nameToUnicode.get(name);
  if (known) return known;
  const base = name.split('.')[0] ?? name;
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(base);
  if (m) return m[1]!.match(/.{4}/g)!.map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (m) return String.fromCodePoint(parseInt(m[1]!, 16));
  if (base !== name) return glyphNameToUnicode(base);
  return null;
}

const STD14: Record<string, FontNames> = {
  Courier: FontNames.Courier, 'Courier-Bold': FontNames.CourierBold, 'Courier-Oblique': FontNames.CourierOblique, 'Courier-BoldOblique': FontNames.CourierBoldOblique,
  Helvetica: FontNames.Helvetica, 'Helvetica-Bold': FontNames.HelveticaBold, 'Helvetica-Oblique': FontNames.HelveticaOblique, 'Helvetica-BoldOblique': FontNames.HelveticaBoldOblique,
  'Times-Roman': FontNames.TimesRoman, 'Times-Bold': FontNames.TimesRomanBold, 'Times-Italic': FontNames.TimesRomanItalic, 'Times-BoldItalic': FontNames.TimesRomanBoldItalic,
  Symbol: FontNames.Symbol, ZapfDingbats: FontNames.ZapfDingbats,
  Arial: FontNames.Helvetica, 'Arial,Bold': FontNames.HelveticaBold, 'Arial-BoldMT': FontNames.HelveticaBold, ArialMT: FontNames.Helvetica,
  'TimesNewRoman': FontNames.TimesRoman, 'TimesNewRomanPSMT': FontNames.TimesRoman, 'CourierNew': FontNames.Courier, 'CourierNewPSMT': FontNames.Courier,
};

const stdCache = new Map<FontNames, StdFont>();
function std14(baseFont: string): StdFont | undefined {
  const key = STD14[baseFont.replace(/^[A-Z]{6}\+/, '')];
  if (!key) return undefined;
  let f = stdCache.get(key);
  if (!f) {
    f = StdFont.load(key);
    stdCache.set(key, f);
  }
  return f;
}

// ---- 読み込み ----

const cache = new WeakMap<PDFDict, FontInfo>();

export function loadFont(ctx: PDFContext, fontObj: PDFDict | PDFRef | undefined): FontInfo {
  const ref = fontObj instanceof PDFRef ? fontObj : undefined;
  const dict = resolve(ctx, fontObj);
  if (!(dict instanceof PDFDict)) return unsupported('', '', 'フォントの定義がありません', ref);
  const hit = cache.get(dict);
  if (hit) return hit;
  const subtype = getName(ctx, dict, 'Subtype') ?? '';
  const baseFont = getName(ctx, dict, 'BaseFont') ?? '';
  let info: FontInfo;
  try {
    info = subtype === 'Type0' ? loadType0(ctx, dict, baseFont, ref) : loadSimple(ctx, dict, subtype, baseFont, ref);
  } catch {
    info = unsupported(subtype, baseFont, 'フォントを読めませんでした', ref);
  }
  cache.set(dict, info);
  return info;
}

function unsupported(subtype: string, baseFont: string, reason: string, ref?: PDFRef): FontInfo {
  return { ref, subtype, baseFont, vertical: false, supported: false, reason, decode: () => [] };
}

function readToUnicode(ctx: PDFContext, dict: PDFDict): CMap | undefined {
  const tu = dictGet(ctx, dict, 'ToUnicode');
  return tu instanceof PDFStream ? parseCMap(streamBytes(tu)) : undefined;
}

function loadSimple(ctx: PDFContext, dict: PDFDict, subtype: string, baseFont: string, ref?: PDFRef): FontInfo {
  const toUnicode = readToUnicode(ctx, dict);
  const first = getNumber(ctx, dict, 'FirstChar') ?? 0;
  const widths = arrayNumbers(ctx, getArray(ctx, dict, 'Widths'));
  const descriptor = getDict(ctx, dict, 'FontDescriptor');
  const missing = getNumber(ctx, descriptor, 'MissingWidth');
  const std = std14(baseFont);
  // Type3 は FontMatrix で 1/1000 単位に直す
  let scale = 1;
  if (subtype === 'Type3') {
    const fm = arrayNumbers(ctx, getArray(ctx, dict, 'FontMatrix'));
    scale = (fm[0] ?? 0.001) * 1000;
  }

  // 符号化: 基本の符号化（WinAnsi を既定とする）に Differences を重ねる
  const names = new Map<number, string>();
  const encObj = dictGet(ctx, dict, 'Encoding');
  const encDict = encObj instanceof PDFDict ? encObj : undefined;
  const baseEnc = encObj instanceof PDFName ? encObj.decodeText() : getName(ctx, encDict, 'BaseEncoding');
  const symbolic = baseFont.includes('Symbol') || baseFont.includes('Dingbats');
  if (!symbolic || baseEnc) for (const [code, v] of winAnsiTable()) names.set(code, v.name);
  const diffs = getArray(ctx, encDict, 'Differences');
  if (diffs) {
    let code = 0;
    for (let i = 0; i < diffs.size(); i++) {
      const v = resolve(ctx, diffs.get(i));
      if (v instanceof PDFNumber) code = v.asNumber();
      else if (v instanceof PDFName) names.set(code++, v.decodeText());
    }
  }

  const unicodeOf = (code: number): string | null => {
    const fromMap = toUnicode?.unicode.get(code);
    if (fromMap !== undefined) return fromMap;
    const n = names.get(code);
    if (n) return glyphNameToUnicode(n);
    return null;
  };
  const widthOf = (code: number): number => {
    const w = widths[code - first];
    if (w !== undefined && Number.isFinite(w)) return w * scale;
    if (std) {
      const n = names.get(code);
      const sw = n ? std.getWidthOfGlyph(n) : undefined;
      if (typeof sw === 'number') return sw;
    }
    if (missing !== undefined) return missing * scale;
    return NaN;
  };
  const hasAnyUnicode = !!toUnicode || names.size > 0;
  return {
    ref,
    subtype,
    baseFont,
    vertical: false,
    supported: hasAnyUnicode,
    reason: hasAnyUnicode ? undefined : '文字の対応表がないフォントです',
    decode(bytes) {
      const out: Glyph[] = [];
      for (let i = 0; i < bytes.length; i++) {
        const code = bytes[i]!;
        out.push({ start: i, end: i + 1, code, unicode: unicodeOf(code), width: widthOf(code), wordSpace: code === 32 });
      }
      return out;
    },
  };
}

const IDENTITY: CodeRange[] = [{ bytes: 2, low: 0, high: 0xffff }];

function loadType0(ctx: PDFContext, dict: PDFDict, baseFont: string, ref?: PDFRef): FontInfo {
  const toUnicode = readToUnicode(ctx, dict);
  const descendants = getArray(ctx, dict, 'DescendantFonts');
  const cidFont = descendants ? resolve(ctx, descendants.get(0)) : undefined;
  const cid = cidFont instanceof PDFDict ? cidFont : undefined;
  const dw = getNumber(ctx, cid, 'DW') ?? 1000;
  const wArr = getArray(ctx, cid, 'W');
  const widths = new Map<number, number>();
  if (wArr) {
    for (let i = 0; i < wArr.size(); ) {
      const a = resolve(ctx, wArr.get(i));
      const b = resolve(ctx, wArr.get(i + 1));
      if (!(a instanceof PDFNumber)) break;
      if (b instanceof PDFArray) {
        arrayNumbers(ctx, b).forEach((w, k) => widths.set(a.asNumber() + k, w));
        i += 2;
      } else {
        const c = resolve(ctx, wArr.get(i + 2));
        if (b instanceof PDFNumber && c instanceof PDFNumber) for (let x = a.asNumber(); x <= b.asNumber(); x++) widths.set(x, c.asNumber());
        i += 3;
      }
    }
  }

  const encObj = dictGet(ctx, dict, 'Encoding');
  let ranges = IDENTITY;
  let vertical = false;
  let toCid: (code: number, len: number) => number | undefined = (code) => code;
  /** 既定 CMap の Uni* 系: 文字コードが Unicode そのもの */
  let unicodeFromCode = false;
  let reason: string | undefined;
  if (encObj instanceof PDFName) {
    const name = encObj.decodeText();
    vertical = name.endsWith('-V');
    if (name === 'Identity-H' || name === 'Identity-V') {
      // そのまま
    } else if (/^Uni\w+-(UCS2|UTF16)-[HV]$/.test(name)) {
      unicodeFromCode = true;
      ranges = name.includes('UTF16') ? [{ bytes: 2, low: 0, high: 0xd7ff }, { bytes: 4, low: 0xd800dc00, high: 0xdbffdfff }, { bytes: 2, low: 0xe000, high: 0xffff }] : IDENTITY;
      // CID が分からないので、幅は既定値（DW）だけが使えるときに限る
      if (widths.size > 0) reason = `既定の符号化（${name}）で幅の表があるフォントには対応していません`;
      toCid = () => undefined;
    } else {
      reason = `既定の符号化（${name}）には対応していません`;
    }
  } else if (encObj instanceof PDFStream) {
    const cmap = parseCMap(streamBytes(encObj));
    vertical = cmap.vertical;
    if (cmap.ranges.length) ranges = cmap.ranges;
    if (cmap.useCMap && !/^Identity-[HV]$/.test(cmap.useCMap) && cmap.cid.size === 0 && cmap.cidRanges.length === 0) reason = `既定の符号化（${cmap.useCMap}）には対応していません`;
    toCid = (code, len) => lookupCid(cmap, code, len) ?? (cmap.useCMap?.startsWith('Identity') ? code : undefined);
  }

  const unicodeOf = (code: number, len: number): string | null => {
    const u = toUnicode?.unicode.get(code);
    if (u !== undefined) return u;
    if (unicodeFromCode) {
      if (len === 4) {
        const hi = code >>> 16;
        const lo = code & 0xffff;
        return String.fromCharCode(hi, lo);
      }
      return String.fromCharCode(code);
    }
    return null;
  };
  const supported = !reason && (!!toUnicode || unicodeFromCode);
  return {
    ref,
    subtype: 'Type0',
    baseFont,
    vertical,
    supported,
    reason: reason ?? (supported ? undefined : '文字の対応表（ToUnicode）がないフォントです'),
    decode(bytes) {
      const out: Glyph[] = [];
      for (let i = 0; i < bytes.length; ) {
        const len = codeLength(ranges, bytes, i);
        let code = 0;
        for (let k = 0; k < len; k++) code = code * 256 + bytes[i + k]!;
        const c = toCid(code, len);
        const w = c === undefined ? (widths.size === 0 ? dw : NaN) : (widths.get(c) ?? dw);
        out.push({ start: i, end: i + len, code, unicode: unicodeOf(code, len), width: w, wordSpace: false });
        i += len;
      }
      return out;
    },
  };
}

/** フォント資源の辞書（/Font）から、名前 → 参照 or 辞書 */
export function fontResource(ctx: PDFContext, resources: PDFDict | undefined, name: string): PDFDict | PDFRef | undefined {
  const fonts = getDict(ctx, resources, 'Font');
  const v = fonts?.get(N(name));
  if (v instanceof PDFRef || v instanceof PDFDict) return v;
  return undefined;
}

export { PDFName };
