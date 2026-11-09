import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFRef, PDFStream, type PDFDocument, type PDFFont } from 'pdf-lib';
import type { OutputSegment } from '../../core/model/types';
import { imgRef, loadEditable, MAX_PAGES, type PdfSource } from './document';
import type { FontInfo } from './fonts';
import { faceLabel } from '../face';
import { replaceImage, type ImageEnv, type PaintGroup, type Rgba } from './images';
import { latin1 } from './lexer';
import { getDict, N, resolve, streamBytes } from './objects';
import { compositeComponents, dropTables, keepOnlyGlyphs, LAYOUT_TABLES, scrubFont } from './fontscrub';
import { applyPieces, PdfEditError, writeUnit, type Piece } from './rewrite';
import { collectGarbage, sanitizeDocument, stripMarkedContent } from './sanitize';
import { applyPoint, buildTextModel, invert, pageText, type GlyphRef, type Matrix, type TextModel } from './textmodel';

// 加工後の文章（segments）を、PDF の形のまま反映する（Issue #9）。
// 1. 置き換えた語の文字を描画命令から取り除き、同じ場所にラベルを書く（位置は変えない）
// 2. 隠した語にしか出てこない字形を含むフォントは、そのフォントの文字をすべて同梱フォントで書き直し、元のフォントを外す
// 3. 画像の中の語は、画素を塗ってラベルを描いた画像に差し替える
// 4. ファイル情報・しおり・構造タグなど本文の外に残る部品を消し、どこからも使われない部品を書き出さない
// 5. 書き出した PDF を読み直し、隠した語が残っていないことを確かめる。残っていれば保存しない

export type PdfEnv = { labelFont: () => Promise<Uint8Array>; images: ImageEnv | null };

export type MaskedPdf = {
  bytes: Uint8Array;
  fileName: string;
  notes: string[];
  /** 差し替えた画像の指紋 → 元の画像（base の中の参照）。復元で元の画素に戻すのに使う。メモリにだけ置く */
  maskedImages: { digest: string; objectNumber: number; generation: number }[];
};

export class PdfExportError extends Error {
  override name = 'PdfExportError';
}

/** 利用者がページ上に描いた、手動で隠す四角形（PDF の座標、左下が原点） */
export type PdfRect = { page: number; x0: number; y0: number; x1: number; y1: number };

export const MANUAL_LABEL = '[手動マスク]';

export function maskedPdfName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)}_加工済み${fileName.slice(dot)}` : `${fileName}_加工済み.pdf`;
}

type Span = { start: number; end: number; label: string; original: string };

export function changedSpans(segments: OutputSegment[]): Span[] {
  const spans: Span[] = [];
  let pos = 0;
  for (const s of segments) {
    const len = s.kind === 'changed' ? s.original.length : s.text.length;
    if (s.kind === 'changed') spans.push({ start: pos, end: pos + len, label: s.text, original: s.original });
    pos += len;
  }
  return spans;
}

/** 文字の並びを、行ごとのかたまりに分ける（行をまたぐ語は、最初の行にだけラベルを書く） */
export function splitLines(model: TextModel, indices: number[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let prev: GlyphRef | undefined;
  for (const i of indices) {
    const g = model.glyphs[i]!;
    if (prev) {
      const len = Math.hypot(prev.dx, prev.dy) || 1;
      const perp = Math.abs((g.x - prev.x) * (-prev.dy / len) + (g.y - prev.y) * (prev.dx / len));
      if (g.unit !== prev.unit || perp > Math.max(prev.h, g.h) * 0.5) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(i);
    prev = g;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** keptFaces は、見つけた顔（src.faces）のうち利用者が残すと選んだものの番号。それ以外の顔は塗りつぶす */
export async function exportMaskedPdf(src: PdfSource, segments: OutputSegment[], env: PdfEnv, rects: PdfRect[] = [], keptFaces: number[] = []): Promise<MaskedPdf> {
  const text = segments.map((s) => (s.kind === 'changed' ? s.original : s.text)).join('');
  if (text !== src.text) throw new PdfExportError('読み込んだ PDF と本文が一致しないため、PDF としては保存できません。');
  if (src.blockers.length) throw new PdfExportError(src.blockers.join('\n'));

  const doc = await loadEditable(src.base);
  doc.registerFontkit(fontkit);
  const model = buildTextModel(doc, MAX_PAGES);
  checkSameModel(model, src);
  const notes: string[] = [];

  // ---- 文字の置き換え ----
  const spans = changedSpans(segments);
  const pieces: Piece[] = [];
  const removed = new Set<number>();
  const imageGroups = new Map<number, PaintGroup[]>();
  for (const sp of spans) {
    const glyphIdx: number[] = [];
    const ocrIdx: number[] = [];
    for (let i = sp.start; i < sp.end; i++) {
      const v = src.charMap[i]!;
      if (v >= 0) {
        if (glyphIdx[glyphIdx.length - 1] !== v) glyphIdx.push(v);
      } else if (v <= -2) {
        const k = -2 - v;
        if (ocrIdx[ocrIdx.length - 1] !== k) ocrIdx.push(k);
      }
    }
    if (glyphIdx.length) {
      splitLines(model, glyphIdx).forEach((line, k) => {
        pieces.push({ glyphs: line, text: k === 0 ? sp.label : '' });
        for (const g of line) removed.add(g);
      });
    }
    if (ocrIdx.length) {
      const byImage = new Map<number, typeof src.ocrChars>();
      for (const k of ocrIdx) {
        const ch = src.ocrChars[k]!;
        byImage.set(ch.image, [...(byImage.get(ch.image) ?? []), ch]);
      }
      let labeled = false;
      for (const [image, chars] of byImage) {
        const groups = imageGroups.get(image) ?? [];
        groups.push({ boxes: lineBoxes(chars), label: labeled ? '' : sp.label });
        labeled = true;
        imageGroups.set(image, groups);
      }
    }
  }

  // ---- 顔: 残すと選んだもの以外を塗る ----
  let faceCount = 0;
  src.faces.forEach((f, i) => {
    if (keptFaces.includes(i)) return;
    const groups = imageGroups.get(f.image) ?? [];
    groups.push({ boxes: [f.box], label: faceLabel(i), center: true });
    imageGroups.set(f.image, groups);
    faceCount++;
  });
  if (faceCount) notes.push(`画像の中の顔 ${faceCount} 件を塗りつぶしました。`);

  // ---- 手動の四角形: 重なる画像の、その範囲の画素を塗る ----
  let rectMiss = 0;
  for (const r of rects) {
    let hit = false;
    for (const pl of model.images) {
      if (pl.page !== r.page) continue;
      const index = src.images.findIndex((e) => e.objectNumber === pl.ref.objectNumber && e.generation === pl.ref.generationNumber);
      const entry = src.images[index];
      if (!entry) continue;
      const box = rectToPixels(r, pl.ctm, entry.width, entry.height);
      if (!box) continue;
      const groups = imageGroups.get(index) ?? [];
      groups.push({ boxes: [box], label: MANUAL_LABEL });
      imageGroups.set(index, groups);
      hit = true;
    }
    if (!hit) rectMiss++;
  }
  if (rectMiss) notes.push(`画像のない場所に描いた四角形が ${rectMiss} 個あり、使いませんでした。文字は「手動でマスク」で隠してください。`);

  // ---- 隠した語にしか出てこない字形を持つフォント ----
  // 埋め込み TrueType などは、その字形だけを空にする（ほかの文字は元のフォントのまま）。
  // それができない形式のフォントだけ、文字をすべて同梱フォントで書き直す
  const leakyCodes = leakyFonts(model, removed);
  const leaky = new Set<FontInfo>();
  let scrubbed = 0;
  for (const [f, codes] of leakyCodes) {
    if (scrubFont(doc, f, codes)) scrubbed++;
    else leaky.add(f);
  }
  if (scrubbed) notes.push(`隠した語にしか使われていない字形を、${scrubbed} 個のフォントから取り除きました（ほかの文字の見た目は変わりません）。`);
  if (leaky.size) {
    const byFont = new Map<FontInfo, number[]>();
    model.glyphs.forEach((g, i) => {
      if (removed.has(i) || !g.state.font || !leaky.has(g.state.font)) return;
      byFont.set(g.state.font, [...(byFont.get(g.state.font) ?? []), i]);
    });
    let dropped = 0;
    for (const indices of byFont.values()) {
      for (const run of runs(model, indices)) {
        const t = run.map((i) => model.glyphs[i]!.unicode);
        if (t.some((u) => u === null)) dropped += t.filter((u) => u === null).length;
        pieces.push({ glyphs: run, text: t.map((u) => u ?? '').join('') });
      }
    }
    replaceFontResources(doc, model, leaky);
    notes.push(`隠した語にしか使われていない字形がフォントに残らないよう、${leaky.size} 個のフォントの文字を同梱フォントで書き直しました（位置と大きさは同じで、字の形が少し変わります）。`);
    if (dropped) notes.push(`書き直せない記号が ${dropped} 個あり、取り除きました。`);
  }

  try {
    const font = await embedLabelFont(doc, await env.labelFont(), pieces.map((x) => x.text));
    applyPieces(doc, model, pieces, font);
  } catch (e) {
    if (e instanceof PdfEditError) throw new PdfExportError(`PDF として保存できませんでした: ${e.message}`);
    throw e;
  }

  // ---- 画像 ----
  const maskedImages: MaskedPdf['maskedImages'] = [];
  if (imageGroups.size) {
    if (!env.images) throw new PdfExportError('画像を加工できない環境です。');
    const entries = [...imageGroups.keys()];
    const decoded = await env.images.decode(src.base, entries.map((i) => imgRef(src.images[i]!)));
    for (let k = 0; k < entries.length; k++) {
      const entry = src.images[entries[k]!]!;
      const img = decoded[k];
      if (!img) throw new PdfExportError(`${entry.page + 1} ページの画像を読めませんでした。`);
      const painted = await env.images.paint(img, imageGroups.get(entries[k]!)!);
      const ref = imgRef(entry);
      replaceImage(doc, ref, painted);
      maskedImages.push({ digest: await streamDigest(doc, ref), objectNumber: entry.objectNumber, generation: entry.generation });
    }
    notes.push(`画像 ${imageGroups.size} 枚の中の語を塗りつぶし、ラベルを書き込みました。`);
  }

  // ---- 本文の外に残る部品を消す ----
  for (const unit of model.units) {
    if (stripMarkedContent(unit.ops as never)) writeUnit(doc, unit);
  }
  sanitizeDocument(doc);
  collectGarbage(doc);
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });

  const maskedText = segments.map((x) => x.text).join('');
  await verifyNoResidue(bytes, spans, maskedText);
  return { bytes, fileName: maskedPdfName(src.fileName), notes, maskedImages };
}

/** ページ上の四角形を、画像の画素の範囲に直す。画像は単位正方形を ctm でページに置いたもの */
export function rectToPixels(r: PdfRect, ctm: Matrix, width: number, height: number) {
  const inv = invert(ctm);
  if (!inv) return null;
  const pts = [applyPoint(inv, r.x0, r.y0), applyPoint(inv, r.x1, r.y0), applyPoint(inv, r.x0, r.y1), applyPoint(inv, r.x1, r.y1)];
  const us = pts.map((p) => p[0]);
  const vs = pts.map((p) => p[1]);
  const u0 = Math.max(0, Math.min(...us)), u1 = Math.min(1, Math.max(...us));
  const v0 = Math.max(0, Math.min(...vs)), v1 = Math.min(1, Math.max(...vs));
  if (u1 <= u0 || v1 <= v0) return null;
  // 画像の 1 行目が上（v=1）
  return { x0: u0 * width, x1: u1 * width, y0: (1 - v1) * height, y1: (1 - v0) * height };
}

/** 読み込み時と同じ文字の並びになっているか（同じ base から作るので一致するはず） */
function checkSameModel(model: TextModel, src: PdfSource) {
  const max = src.charMap.reduce((m, v) => Math.max(m, v), -1);
  if (max >= model.glyphs.length) throw new PdfExportError('読み込んだ PDF の解析結果と合いません。読み込み直してください。');
}

/** OCR の文字の箱を、行ごとの1つの箱にまとめる */
export function lineBoxes(chars: { x0: number; y0: number; x1: number; y1: number }[]) {
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const c of chars) {
    const last = boxes[boxes.length - 1];
    const h = c.y1 - c.y0;
    if (last && Math.abs((last.y0 + last.y1) / 2 - (c.y0 + c.y1) / 2) < h * 0.6 && c.x0 >= last.x0 - h) {
      last.x0 = Math.min(last.x0, c.x0);
      last.y0 = Math.min(last.y0, c.y0);
      last.x1 = Math.max(last.x1, c.x1);
      last.y1 = Math.max(last.y1, c.y1);
    } else boxes.push({ ...c });
  }
  return boxes;
}

/** フォントごとに、取り除いた文字コードのうち、残る文字のどこにも使われていないもの（フォントに残ると漏れる字形） */
export function leakyFonts(model: TextModel, removed: Set<number>): Map<FontInfo, Set<number>> {
  const kept = new Map<FontInfo, Set<number>>();
  const gone = new Map<FontInfo, Set<number>>();
  model.glyphs.forEach((g, i) => {
    const f = g.state.font;
    if (!f) return;
    const m = removed.has(i) ? gone : kept;
    const set = m.get(f) ?? new Set<number>();
    set.add(g.code);
    m.set(f, set);
  });
  const out = new Map<FontInfo, Set<number>>();
  for (const [f, codes] of gone) {
    const k = kept.get(f) ?? new Set<number>();
    const only = new Set([...codes].filter((c) => !k.has(c)));
    if (only.size) out.set(f, only);
  }
  // フォントの中に残るほかの字形（どこにも使われていないもの）も同じ理由で漏れうるが、
  // 隠した語に由来しない限り情報にはならないので対象にしない
  return out;
}

/** 同じ命令・同じ行の連続した文字ごとに分ける */
function runs(model: TextModel, indices: number[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let prev: GlyphRef | undefined;
  for (const i of indices) {
    const g = model.glyphs[i]!;
    // 文字の間が空いている所（表の別のセルなど）でも分ける。つなげて書き直すと、離れていた文字がくっつく
    const apart = prev ? Math.hypot(g.x - (prev.x + prev.dx), g.y - (prev.y + prev.dy)) > Math.max(prev.h, g.h) * 0.3 : false;
    if (prev && (apart || g.unit !== prev.unit || g.op !== prev.op || i !== (cur[cur.length - 1] ?? -2) + 1)) {
      out.push(cur);
      cur = [];
    }
    cur.push(i);
    prev = g;
  }
  if (cur.length) out.push(cur);
  return out.flatMap((r) => splitLines(model, r));
}

/** 書き直したフォントの資源を、中身のない標準フォントに差し替える（Tf の大きさの指定だけに使われる） */
function replaceFontResources(doc: PDFDocument, model: TextModel, leaky: Set<FontInfo>) {
  const ctx = doc.context;
  const blank = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const leakyDicts = new Set<PDFDict>();
  for (const f of leaky) {
    const d = f.ref ? ctx.lookup(f.ref) : undefined;
    if (d instanceof PDFDict) leakyDicts.add(d);
  }
  for (const unit of model.units) {
    const fonts = getDict(ctx, unit.resources, 'Font');
    if (!fonts) continue;
    for (const [k, v] of fonts.entries()) {
      const d = resolve(ctx, v);
      if (d instanceof PDFDict && leakyDicts.has(d)) fonts.set(k, blank);
    }
  }
  for (const f of leaky) if (!f.ref) throw new PdfExportError('ページに直接書かれたフォントは書き直せません。');
}

async function streamDigest(doc: PDFDocument, ref: PDFRef): Promise<string> {
  const s = doc.context.lookup(ref);
  if (!(s instanceof PDFStream)) return '';
  return digestBytes(streamBytes(s));
}

export async function digestBytes(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new Uint8Array(b));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 書き出した PDF に、隠した語が文字として残っていないか確かめる */
async function verifyNoResidue(bytes: Uint8Array, spans: Span[], maskedText: string) {
  // 利用者が残すと決めた箇所に同じ語があるものは、残っていて当然なので調べない
  const words = [...new Set(spans.map((s) => s.original.trim()).filter((w) => w.length >= 2 && !maskedText.includes(w)))];
  if (!words.length) return;
  const doc = await loadEditable(bytes);
  const model = buildTextModel(doc);
  const all = model.glyphs.map((_, i) => i);
  const { text } = pageText(model.glyphs, all);
  const compact = text.replace(/\s+/g, '');
  // ストリームの中身（フォントの対応表・メタデータを含む）も、UTF-16 と UTF-8 で探す
  const raw: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      if (obj.dict.get(N('Subtype'))?.toString() === '/Image') continue;
      try {
        raw.push(latin1(streamBytes(obj)));
      } catch {
        /* 画像など展開できない中身は対象外 */
      }
    } else raw.push(String(obj));
  }
  const haystack = raw.join('\n');
  for (const w of words) {
    const compactWord = w.replace(/\s+/g, '');
    if (compactWord.length >= 2 && compact.includes(compactWord)) throw new PdfExportError('加工後の PDF に、隠した語が文字として残っていました。保存を中止しました。');
    if (haystack.includes(latin1(new TextEncoder().encode(w))) || haystack.includes(utf16(w))) {
      throw new PdfExportError('加工後の PDF の中に、隠した語のデータが残っていました。保存を中止しました。');
    }
  }
}

function utf16(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += String.fromCharCode(c >> 8, c & 0xff);
  }
  return out;
}

export type { PDFFont, Rgba };
export { N };

/**
 * 書き込む文字列に使う字形だけを持つフォントを埋め込む。
 * pdf-lib の部分埋め込み（subset）は、このフォントでは一部の字形が壊れるため使わない。
 * 代わりに、使わない字形の輪郭を空にしたフォントを丸ごと埋め込む（字形の番号は変わらないので、文字の割り当てがずれない）。
 */
export async function embedLabelFont(doc: PDFDocument, fontBytes: Uint8Array, texts: string[]): Promise<PDFFont> {
  const plain = dropTables(fontBytes, LAYOUT_TABLES);
  const f = fontkit.create(plain as never) as unknown as { glyphForCodePoint(cp: number): { id: number } };
  const keep = new Set<number>([0]);
  const chars = new Map<number, number>();
  for (const t of [...texts, ' ']) {
    for (const ch of t) {
      const cp = ch.codePointAt(0)!;
      const id = f.glyphForCodePoint(cp).id;
      keep.add(id);
      if (id) chars.set(cp, id);
    }
  }
  for (const g of [...keep]) for (const c of compositeComponents(plain, g)) keep.add(c);
  return doc.embedFont(keepOnlyGlyphs(plain, keep, chars), { subset: false });
}
