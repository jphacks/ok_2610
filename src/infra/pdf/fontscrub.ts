import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, type PDFDocument } from 'pdf-lib';
import { zlibSync } from 'fflate';
import { parseCMap } from './cmap';
import type { FontInfo } from './fonts';
import { dictGet, getDict, getName, N, resolve, streamBytes } from './objects';

// 隠した語にしか使われていない字形を、フォントから取り除く（Issue #9 の「隠したい情報を残さない」）。
// 埋め込みの TrueType（CIDFontType2）なら、その字形の輪郭を空にし、文字の対応表（ToUnicode）・字形名（post）・cmap・CIDSet からも消す。
// 本文のほかの文字は元のフォントのまま描かれるので、見た目は変わらない。
// 対応していない形式のフォントは false を返し、呼び出し側で同梱フォントに書き直す。

export function scrubFont(doc: PDFDocument, font: FontInfo, codes: Set<number>): boolean {
  if (!font.ref) return false;
  const ctx = doc.context;
  const dict = resolve(ctx, font.ref);
  if (!(dict instanceof PDFDict)) return false;

  let descriptor: PDFDict | undefined;
  let gidOf: ((code: number) => number | undefined) | null = null;
  if (font.subtype === 'Type0') {
    const enc = getName(ctx, dict, 'Encoding');
    if (enc !== 'Identity-H' && enc !== 'Identity-V') return false;
    const desc = dictGet(ctx, dict, 'DescendantFonts');
    const cid = desc instanceof PDFArray ? resolve(ctx, desc.get(0)) : undefined;
    if (!(cid instanceof PDFDict)) return false;
    descriptor = getDict(ctx, cid, 'FontDescriptor');
    const map = dictGet(ctx, cid, 'CIDToGIDMap');
    if (map === undefined || (map instanceof PDFName && map.decodeText() === 'Identity')) gidOf = (c) => c;
    else if (map instanceof PDFStream) {
      const b = streamBytes(map);
      gidOf = (c) => (c * 2 + 1 < b.length ? (b[c * 2]! << 8) | b[c * 2 + 1]! : undefined);
    } else return false;
    if (getName(ctx, cid, 'Subtype') !== 'CIDFontType2' && hasFontFile(ctx, descriptor)) return false;
  } else {
    descriptor = getDict(ctx, dict, 'FontDescriptor');
    // 単純フォントは、埋め込みがなければ対応表を消すだけでよい
    if (hasFontFile(ctx, descriptor)) return false;
  }

  if (hasFontFile(ctx, descriptor)) {
    const ffRef = descriptor!.get(N('FontFile2'));
    const ff = resolve(ctx, ffRef);
    if (!(ffRef instanceof PDFRef) || !(ff instanceof PDFStream) || !gidOf) return false;
    const gids = new Set<number>();
    for (const c of codes) {
      const g = gidOf(c);
      if (g !== undefined && g !== 0) gids.add(g);
    }
    let out: Uint8Array;
    try {
      out = blankTrueTypeGlyphs(streamBytes(ff), gids);
    } catch {
      return false;
    }
    const d = ctx.obj({}) as PDFDict;
    d.set(N('Filter'), N('FlateDecode'));
    d.set(N('Length1'), ctx.obj(out.length));
    ctx.assign(ffRef, PDFRawStream.of(d, zlibSync(out)));
    descriptor!.delete(N('CIDSet'));
    descriptor!.delete(N('CharSet'));
  }
  rewriteToUnicode(doc, dict, codes);
  return true;
}

function hasFontFile(ctx: PDFDocument['context'], descriptor: PDFDict | undefined): boolean {
  if (!descriptor) return false;
  return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => resolve(ctx, descriptor.get(N(k))) instanceof PDFStream);
}

/** ToUnicode から、取り除いた文字コードの対応を消して書き直す */
function rewriteToUnicode(doc: PDFDocument, dict: PDFDict, codes: Set<number>) {
  const ctx = doc.context;
  const raw = dict.get(N('ToUnicode'));
  const tu = resolve(ctx, raw);
  if (!(tu instanceof PDFStream)) return;
  const cmap = parseCMap(streamBytes(tu));
  const bytes = cmap.ranges[0]?.bytes ?? 2;
  const lo = cmap.ranges.length ? Math.min(...cmap.ranges.map((r) => r.low)) : 0;
  const hi = cmap.ranges.length ? Math.max(...cmap.ranges.map((r) => r.high)) : 0xffff;
  const hex = (v: number, n: number) => v.toString(16).padStart(n * 2, '0').toUpperCase();
  const utf16 = (s: string) => [...s].map((ch) => {
    const c = ch.codePointAt(0)!;
    if (c <= 0xffff) return hex(c, 2);
    const v = c - 0x10000;
    return hex(0xd800 + (v >> 10), 2) + hex(0xdc00 + (v & 0x3ff), 2);
  }).join('');
  const entries = [...cmap.unicode.entries()].filter(([c]) => !codes.has(c)).sort((a, b) => a[0] - b[0]);
  let body = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n';
  body += `1 begincodespacerange\n<${hex(lo, bytes)}> <${hex(hi, bytes)}>\nendcodespacerange\n`;
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n` + chunk.map(([c, u]) => `<${hex(c, bytes)}> <${utf16(u)}>`).join('\n') + '\nendbfchar\n';
  }
  body += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  const stream = ctx.flateStream(body);
  if (raw instanceof PDFRef) ctx.assign(raw, stream);
  else dict.set(N('ToUnicode'), ctx.register(stream));
}

// ---- TrueType ----

type Table = { tag: string; data: Uint8Array };

/** 指定した字形の輪郭を空にした TrueType を返す。字形名（post）は消し、cmap は空にする */
export function blankTrueTypeGlyphs(font: Uint8Array, gids: Set<number>): Uint8Array {
  return rebuildTrueType(font, { blank: (g) => gids.has(g), emptyCmap: true });
}

/**
 * 文字を書き込む用のフォントを作る: keep 以外の字形の輪郭を空にし、字形の置き換えの表を外す。字形の番号は変えない。
 * cmap も使う文字だけにする（埋め込んだ PDF の文字の対応表に、書いていない文字が並ばないように）
 */
export function keepOnlyGlyphs(font: Uint8Array, keep: Set<number>, chars: Map<number, number>): Uint8Array {
  return rebuildTrueType(font, { blank: (g) => g !== 0 && !keep.has(g), emptyCmap: false, drop: LAYOUT_TABLES, cmap: chars });
}

/** 文字の並べ方を変える表。外すと、文字と字形が cmap の1対1になる（pdf-lib の文字の割り当てと一致させるため） */
export const LAYOUT_TABLES = ['GSUB', 'GPOS', 'GDEF', 'BASE', 'JSTF', 'morx', 'mort', 'kern', 'kerx', 'vhea', 'vmtx', 'VORG', 'DSIG', 'hdmx', 'LTSH', 'VDMX', 'STAT', 'MATH', 'meta'];

/** 字形の置き換えの表だけを外す（使う字形を求める前の段階） */
export function dropTables(font: Uint8Array, drop: string[]): Uint8Array {
  return rebuildTrueType(font, { blank: () => false, emptyCmap: false, drop });
}

/** 複合字形が参照している部品の字形番号 */
export function compositeComponents(font: Uint8Array, gid: number): number[] {
  const t = readTables(font);
  const out: number[] = [];
  const seen = new Set<number>();
  const visit = (g: number) => {
    if (seen.has(g)) return;
    seen.add(g);
    const data = t.glyph(g);
    if (data.length < 10 || new DataView(data.buffer, data.byteOffset).getInt16(0) >= 0) return;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 10;
    for (let guard = 0; guard < 64 && at + 4 <= data.length; guard++) {
      const flags = v.getUint16(at);
      const comp = v.getUint16(at + 2);
      out.push(comp);
      visit(comp);
      at += 4 + (flags & 0x0001 ? 4 : 2);
      if (flags & 0x0008) at += 2;
      else if (flags & 0x0040) at += 4;
      else if (flags & 0x0080) at += 8;
      if (!(flags & 0x0020)) break;
    }
  };
  visit(gid);
  return out;
}

function readTables(font: Uint8Array) {
  const dv = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const numTables = dv.getUint16(4);
  const tables: Table[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(font[at]!, font[at + 1]!, font[at + 2]!, font[at + 3]!);
    const offset = dv.getUint32(at + 8);
    const length = dv.getUint32(at + 12);
    if (offset + length > font.length) throw new Error('壊れたフォント');
    tables.push({ tag, data: font.slice(offset, offset + length) });
  }
  const get = (tag: string) => tables.find((t) => t.tag === tag);
  const head = get('head');
  const maxp = get('maxp');
  const loca = get('loca');
  const glyf = get('glyf');
  if (!head || !maxp || !loca || !glyf) throw new Error('TrueType の輪郭がありません');
  const longLoca = new DataView(head.data.buffer).getInt16(50) === 1;
  const numGlyphs = new DataView(maxp.data.buffer).getUint16(4);
  const ldv = new DataView(loca.data.buffer);
  const offsetOf = (g: number) => (longLoca ? ldv.getUint32(g * 4) : ldv.getUint16(g * 2) * 2);
  return { sfnt: dv.getUint32(0), tables, get, longLoca, numGlyphs, offsetOf, glyph: (g: number) => glyf.data.subarray(offsetOf(g), offsetOf(g + 1)) };
}

function rebuildTrueType(font: Uint8Array, opts: { blank: (gid: number) => boolean; emptyCmap: boolean; drop?: string[]; cmap?: Map<number, number> }): Uint8Array {
  const t = readTables(font);
  const { sfnt, get, longLoca, numGlyphs, offsetOf } = t;
  const tables = t.tables.filter((x) => !opts.drop?.includes(x.tag));
  const loca = get('loca')!;
  const glyf = get('glyf')!;

  const parts: Uint8Array[] = [];
  const newOffsets: number[] = [];
  let pos = 0;
  for (let g = 0; g < numGlyphs; g++) {
    newOffsets.push(pos);
    if (opts.blank(g)) continue;
    const a = offsetOf(g);
    const b = offsetOf(g + 1);
    if (b > a) {
      let piece = glyf.data.subarray(a, b);
      if (piece.length % 2) piece = concat([piece, new Uint8Array(1)]);
      parts.push(piece);
      pos += piece.length;
    }
  }
  newOffsets.push(pos);
  glyf.data = concat(parts);
  const newLoca = new Uint8Array((numGlyphs + 1) * (longLoca ? 4 : 2));
  const nl = new DataView(newLoca.buffer);
  newOffsets.forEach((o, i) => (longLoca ? nl.setUint32(i * 4, o) : nl.setUint16(i * 2, o / 2)));
  loca.data = newLoca;

  // 字形名（uni7530 など）から文字が分かるので、名前のない形式（3.0）にする
  const post = get('post');
  if (post && post.data.length >= 32) {
    const p = post.data.slice(0, 32);
    new DataView(p.buffer).setUint32(0, 0x00030000);
    post.data = p;
  }
  // cmap（Unicode → 字形）も文字の一覧になるので、空の表にする。CIDFontType2 の描画には使われない
  const cmap = get('cmap');
  if (cmap && opts.emptyCmap) cmap.data = emptyCmap();
  else if (cmap && opts.cmap) cmap.data = cmapFor(opts.cmap);
  // CIDSet 相当の情報を持つ表はないが、字形の並びを示す表は残してよい（輪郭と文字の対応がないため）

  return writeSfnt(sfnt, tables);
}

/** 文字 → 字形の対応だけを持つ cmap（format 4、BMP の文字のみ） */
function cmapFor(chars: Map<number, number>): Uint8Array {
  const entries = [...chars.entries()].filter(([cp]) => cp < 0xffff).sort((a, b) => a[0] - b[0]);
  const segs = [...entries.map(([cp, gid]) => ({ start: cp, end: cp, delta: (gid - cp) & 0xffff })), { start: 0xffff, end: 0xffff, delta: 1 }];
  const n = segs.length;
  const subLen = 16 + n * 8;
  const b = new Uint8Array(12 + subLen);
  const v = new DataView(b.buffer);
  v.setUint16(0, 0);
  v.setUint16(2, 1);
  v.setUint16(4, 3);
  v.setUint16(6, 1);
  v.setUint32(8, 12);
  const o = 12;
  const es = Math.floor(Math.log2(n));
  v.setUint16(o, 4);
  v.setUint16(o + 2, subLen);
  v.setUint16(o + 4, 0);
  v.setUint16(o + 6, n * 2);
  v.setUint16(o + 8, 2 ** es * 2);
  v.setUint16(o + 10, es);
  v.setUint16(o + 12, n * 2 - 2 ** es * 2);
  segs.forEach((sg, i) => {
    v.setUint16(o + 14 + i * 2, sg.end);
    v.setUint16(o + 16 + n * 2 + i * 2, sg.start);
    v.setUint16(o + 16 + n * 4 + i * 2, sg.delta);
    v.setUint16(o + 16 + n * 6 + i * 2, 0);
  });
  return b;
}

function emptyCmap(): Uint8Array {
  const b = new Uint8Array(36);
  const v = new DataView(b.buffer);
  v.setUint16(0, 0); // version
  v.setUint16(2, 1); // numTables
  v.setUint16(4, 3); // platform
  v.setUint16(6, 1); // encoding
  v.setUint32(8, 12); // offset
  v.setUint16(12, 4); // format 4
  v.setUint16(14, 24); // length
  v.setUint16(16, 0); // language
  v.setUint16(18, 2); // segCountX2
  v.setUint16(20, 2); // searchRange
  v.setUint16(22, 0); // entrySelector
  v.setUint16(24, 0); // rangeShift
  v.setUint16(26, 0xffff); // endCode
  v.setUint16(28, 0); // reservedPad
  v.setUint16(30, 0xffff); // startCode
  v.setUint16(32, 1); // idDelta
  v.setUint16(34, 0); // idRangeOffset
  return b;
}

function checksum(b: Uint8Array): number {
  let sum = 0;
  const padded = b.length % 4 ? concat([b, new Uint8Array(4 - (b.length % 4))]) : b;
  const v = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

function writeSfnt(sfnt: number, tables: Table[]): Uint8Array {
  const n = tables.length;
  const head = tables.find((t) => t.tag === 'head')!;
  new DataView(head.data.buffer).setUint32(8, 0);
  let offset = 12 + n * 16;
  const placed = tables.map((t) => {
    const at = offset;
    offset += Math.ceil(t.data.length / 4) * 4;
    return { ...t, at };
  });
  const out = new Uint8Array(offset);
  const v = new DataView(out.buffer);
  v.setUint32(0, sfnt);
  v.setUint16(4, n);
  const es = Math.floor(Math.log2(n));
  v.setUint16(6, 2 ** es * 16);
  v.setUint16(8, es);
  v.setUint16(10, n * 16 - 2 ** es * 16);
  placed.forEach((t, i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[r + k] = t.tag.charCodeAt(k);
    v.setUint32(r + 4, checksum(t.data));
    v.setUint32(r + 8, t.at);
    v.setUint32(r + 12, t.data.length);
    out.set(t.data, t.at);
  });
  const adj = (0xb1b0afba - checksum(out)) >>> 0;
  const headAt = placed.find((t) => t.tag === 'head')!.at;
  v.setUint32(headAt + 8, adj);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
