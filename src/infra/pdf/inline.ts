import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFDocument, type PDFObject } from 'pdf-lib';
import { zlibSync } from 'fflate';
import { name, parseContent, serializeContent, type Op, type Token } from './lexer';
import { dictGet, getDict, getName, inherited, N, resolve, streamBytes } from './objects';
import { pageContentBytes } from './textmodel';

// 本文に直接埋め込まれた画像（インライン画像: BI … ID … EI）を、ふつうの画像（画像 XObject）に置き換える。
// 履歴書の顔写真がインライン画像で入っている PDF があり、そのままでは OCR・顔の検出・塗りつぶしの対象にならなかった。
// 描き方（いまの座標系の 1×1 の正方形に描く）は「/名前 Do」と同じなので、見た目は変わらない。
// 取り込みのときに置き換えておけば、OCR・顔・マスク・復元はふつうの画像と同じ処理で済む。

/** インライン画像の辞書の略号（PDF 32000-1 表 93） */
const KEY_ABBR: Record<string, string> = {
  BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms', F: 'Filter', H: 'Height', IM: 'ImageMask', I: 'Interpolate', W: 'Width', L: 'Length',
};
/** 色空間・フィルタの名前の略号（表 94） */
const VALUE_ABBR: Record<string, string> = {
  G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed',
  AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode',
};
const DEVICE_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Indexed', 'Pattern']);
const MAX_DEPTH = 8;

function toObject(doc: PDFDocument, tok: Token, expand: boolean): PDFObject {
  const ctx = doc.context;
  switch (tok.t) {
    case 'num': return PDFNumber.of(tok.v);
    case 'name': return N(expand ? (VALUE_ABBR[tok.v] ?? tok.v) : tok.v);
    case 'str': return PDFHexString.of([...tok.bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));
    case 'arr': {
      const arr = PDFArray.withContext(ctx);
      for (const item of tok.items) arr.push(toObject(doc, item, expand));
      return arr;
    }
    case 'dict': {
      const d = ctx.obj({}) as PDFDict;
      for (const [k, v] of tok.entries) d.set(N(k), toObject(doc, v, false));
      return d;
    }
    case 'kw': return tok.v === 'true' ? PDFBool.True : tok.v === 'false' ? PDFBool.False : PDFNull;
  }
}

/** インライン画像を画像 XObject のストリームにする。読めない形なら null（元のまま残す） */
export function inlineToXObject(doc: PDFDocument, inline: NonNullable<Op['inline']>, resources: PDFDict | undefined): PDFRawStream | null {
  const ctx = doc.context;
  const dict = ctx.obj({ Type: 'XObject', Subtype: 'Image' }) as PDFDict;
  for (const [rawKey, tok] of inline.dict) {
    const key = KEY_ABBR[rawKey] ?? rawKey;
    if (key === 'Length') continue;
    // 色空間・フィルタの名前だけ略号を展開する（Decode の数値や DecodeParms はそのまま）
    let value = toObject(doc, tok, key === 'ColorSpace' || key === 'Filter');
    // 名前の付いた色空間（/CS /CS0）は、ページの資源から実物を引く。画像 XObject では名前で参照できないため
    if (key === 'ColorSpace' && value instanceof PDFName && !DEVICE_SPACES.has(value.decodeText())) {
      const named = getDict(ctx, resources, 'ColorSpace')?.get(value);
      if (!named) return null;
      value = named;
    }
    dict.set(N(key), value);
  }
  if (!(dict.get(N('Width')) instanceof PDFNumber) || !(dict.get(N('Height')) instanceof PDFNumber)) return null;
  return PDFRawStream.of(dict, inline.data);
}

/** 資源の XObject に、まだ使われていない名前で登録する */
function register(doc: PDFDocument, resources: PDFDict, ref: PDFRef, used: Set<string>): string {
  const ctx = doc.context;
  let xobjects = getDict(ctx, resources, 'XObject');
  if (!xobjects) {
    xobjects = ctx.obj({}) as PDFDict;
    resources.set(N('XObject'), xobjects);
  }
  let n = 0;
  let key = 'TCInline0';
  while (xobjects.get(N(key)) || used.has(key)) key = `TCInline${++n}`;
  used.add(key);
  xobjects.set(N(key), ref);
  return key;
}

/** 命令の並びの中のインライン画像を置き換える。置き換えたら true */
function liftOps(doc: PDFDocument, ops: Op[], resources: () => PDFDict, used: Set<string>): boolean {
  let changed = false;
  for (let i = 0; i < ops.length; i++) {
    const inline = ops[i]!.inline;
    if (!inline) continue;
    const stream = inlineToXObject(doc, inline, resources());
    if (!stream) continue;
    const ref = doc.context.register(stream);
    ops[i] = { op: 'Do', args: [name(register(doc, resources(), ref, used))] };
    changed = true;
  }
  return changed;
}

/**
 * 文書のすべてのページ（とページから使われるフォーム XObject）のインライン画像を、画像 XObject に置き換える。
 * 戻り値は置き換えた数。読めない形のインライン画像は元のまま残す（textmodel が検査できないことを伝える）
 */
export function liftInlineImages(doc: PDFDocument): number {
  const ctx = doc.context;
  const used = new Set<string>();
  const seenForms = new Set<string>();
  let count = 0;

  const visitForms = (resources: PDFDict | undefined, depth: number) => {
    const xobjects = getDict(ctx, resources, 'XObject');
    if (!xobjects || depth > MAX_DEPTH) return;
    for (const [, raw] of xobjects.entries()) {
      if (!(raw instanceof PDFRef) || seenForms.has(raw.tag)) continue;
      const form = resolve(ctx, raw);
      if (!(form instanceof PDFStream) || getName(ctx, form.dict, 'Subtype') !== 'Form') continue;
      seenForms.add(raw.tag);
      const fres = dictGet(ctx, form.dict, 'Resources');
      let formResources = fres instanceof PDFDict ? fres : resources;
      let ops: Op[];
      try {
        ops = parseContent(streamBytes(form));
      } catch {
        continue;
      }
      const before = ops.filter((o) => o.inline).length;
      const changed = liftOps(doc, ops, () => {
        if (!formResources) {
          formResources = ctx.obj({}) as PDFDict;
          form.dict.set(N('Resources'), formResources);
        }
        return formResources;
      }, used);
      if (changed) {
        count += before - ops.filter((o) => o.inline).length;
        const dict = ctx.obj({}) as PDFDict;
        for (const [k, v] of form.dict.entries()) {
          const key = k.decodeText();
          if (key !== 'Length' && key !== 'Filter' && key !== 'DecodeParms') dict.set(k, v);
        }
        dict.set(N('Filter'), N('FlateDecode'));
        ctx.assign(raw, PDFRawStream.of(dict, zlibSync(serializeContent(ops))));
      }
      visitForms(formResources, depth + 1);
    }
  };

  for (const page of doc.getPages()) {
    const leaf = page.node;
    const bytes = pageContentBytes(doc, leaf);
    const found = inherited(ctx, leaf, 'Resources');
    let resources = found instanceof PDFDict ? found : undefined;
    // インライン画像を含まないページは、命令を読み直して書き戻すことはしない（関係のないページを変えない）
    let ops: Op[] | null = null;
    if (bytes.length && hasInlineImage(bytes)) {
      try {
        ops = parseContent(bytes);
      } catch {
        ops = null;
      }
    }
    if (ops) {
      const before = ops.filter((o) => o.inline).length;
      const changed = liftOps(doc, ops, () => {
        if (!resources) {
          resources = ctx.obj({}) as PDFDict;
          leaf.set(N('Resources'), resources);
        }
        return resources;
      }, used);
      if (changed) {
        count += before - ops.filter((o) => o.inline).length;
        leaf.set(N('Contents'), ctx.register(ctx.flateStream(serializeContent(ops))));
      }
    }
    visitForms(resources, 0);
  }
  return count;
}

/** 「BI」の命令がありそうか（速く見分けるための粗い判定。最後は parseContent で確かめる） */
function hasInlineImage(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x42 && bytes[i + 1] === 0x49) {
      const before = i === 0 ? 0x20 : bytes[i - 1]!;
      const after = i + 2 >= bytes.length ? 0x20 : bytes[i + 2]!;
      if (/[\s]/.test(String.fromCharCode(before)) && /[\s/]/.test(String.fromCharCode(after))) return true;
    }
  }
  return false;
}
