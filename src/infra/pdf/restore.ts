import fontkit from '@pdf-lib/fontkit';
import { PDFObjectCopier, PDFRef, PDFStream, type PDFDocument } from 'pdf-lib';
import { restoreLabels as restoreText } from '../../core/restore';
import { loadEditable, PdfImportError } from './document';
import { imageInfo, ocrText, replaceImage, worthOcr, type PaintGroup } from './images';
import { digestBytes, embedLabelFont, splitLines, type PdfEnv } from './mask';
import { streamBytes } from './objects';
import { applyPieces, PdfEditError, spanWidth, type Piece, type RunGlyph } from './rewrite';
import { flattenAnnotations } from './sanitize';
import { buildTextModel, pageText, type GlyphRef, type TextModel } from './textmodel';

// AIなどから戻ってきた PDF の中のラベルを、元の語に戻す（Issue #9）。
// 文字のラベルは、その位置・幅のまま元の語に書き換える。マスクした元の PDF が手元にあれば、元の語を
// 元のフォント・大きさ・1文字ずつの位置のまま書き戻す（書体や太さも元どおりになる）。ないときは同梱のフォントで書く。自分がマスクした画像は元の画素に戻し、
// それ以外の画像は OCR でラベルを探して、元の語を描き込む。

export type PdfRestoreInput = {
  fileName: string;
  bytes: Uint8Array;
  restoreMap: Record<string, string>;
  generalizedMap: Record<string, string>;
  /** マスクしたときの土台（元の画像を取り出す）と、差し替えた画像の指紋 */
  original?: { base: Uint8Array; maskedImages: { digest: string; objectNumber: number; generation: number }[] };
};

export type PdfRestoreResult = { bytes: Uint8Array; fileName: string; replaced: number; images: number; unmatched: string[]; notes: string[] };

export class PdfRestoreError extends Error {
  override name = 'PdfRestoreError';
}

export function restoredPdfName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem.replace(/_加工済み$/, '')}_復元済み.pdf`;
}

/** 文章の中のラベルの出現を探す。長いラベルから順に、重ならないように取る */
export function findLabels(text: string, map: Record<string, string>): { start: number; end: number; original: string }[] {
  const keys = Object.keys(map).filter(Boolean).sort((a, b) => b.length - a.length);
  const taken = new Uint8Array(text.length);
  const out: { start: number; end: number; original: string }[] = [];
  for (const key of keys) {
    for (let i = text.indexOf(key); i !== -1; i = text.indexOf(key, i + 1)) {
      const end = i + key.length;
      // 「人物A」が「人物AB」の一部にならないように
      if (/[A-Za-z0-9]$/.test(key) && /[A-Za-z0-9]/.test(text[end] ?? '')) continue;
      if (taken.subarray(i, end).some((v) => v)) continue;
      taken.fill(1, i, end);
      out.push({ start: i, end, original: map[key]! });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function restorePdf(input: PdfRestoreInput, env: PdfEnv): Promise<PdfRestoreResult> {
  let doc;
  try {
    doc = await loadEditable(input.bytes);
  } catch (e) {
    throw new PdfRestoreError(e instanceof PdfImportError ? e.message : 'PDF を読めませんでした。');
  }
  flattenAnnotations(doc);
  doc.registerFontkit(fontkit);
  const model = buildTextModel(doc);
  const map = { ...input.generalizedMap, ...input.restoreMap };
  const notes: string[] = [];

  // ---- 文字 ----
  const original = input.original ? await loadOriginal(input.original.base, doc) : null;
  const pieces: Piece[] = [];
  let replaced = 0;
  let substituted = 0;
  const unmatched = new Set<string>();
  const byPage: number[][] = Array.from({ length: model.pageCount }, () => []);
  model.glyphs.forEach((g, i) => byPage[g.page]?.push(i));
  for (const indices of byPage) {
    const { text, map: charMap } = pageText(model.glyphs, indices);
    for (const u of restoreText(text, input.restoreMap, input.generalizedMap).unmatched) unmatched.add(u);
    for (const hit of findLabels(text, map)) {
      const glyphs: number[] = [];
      for (let i = hit.start; i < hit.end; i++) {
        const v = charMap[i]!;
        if (v >= 0 && glyphs[glyphs.length - 1] !== v) glyphs.push(v);
      }
      if (!glyphs.length) continue;
      splitLines(model, glyphs).forEach((line, k) => {
        if (k > 0) return pieces.push({ glyphs: line, text: '' });
        const run = original && originalRun(original, model.glyphs[line[0]!]!, hit.original);
        if (run) return pieces.push({ glyphs: line, text: '', run });
        substituted++;
        // 自分が加工した PDF では、ラベルの後ろに元の語の幅だけ空きが残っている。そこまで使って元の大きさで書く
        const after = trailing(model, line[line.length - 1]!);
        pieces.push({ glyphs: line, text: hit.original, width: spanWidth(line.map((i) => model.glyphs[i]!)) + after.gap, size: after.size });
      });
      replaced++;
    }
  }
  if (substituted) notes.push(`${substituted}箇所は元の PDF の同じ場所に見つからなかったため、同梱のゴシック体で書きました（書体と太さが元と違って見えることがあります）。`);
  try {
    const font = await embedLabelFont(doc, await env.labelFont(), pieces.map((x) => x.text));
    applyPieces(doc, model, pieces, font);
  } catch (e) {
    if (e instanceof PdfEditError) throw new PdfRestoreError(`元の語に戻せませんでした: ${e.message}`);
    throw e;
  }

  // ---- 画像 ----
  let images = 0;
  const seen = new Set<string>();
  const refs: PDFRef[] = [];
  for (const pl of model.images) {
    if (seen.has(pl.ref.tag)) continue;
    seen.add(pl.ref.tag);
    refs.push(pl.ref);
  }
  if (refs.length && env.images) {
    const own = new Map((input.original?.maskedImages ?? []).map((m) => [m.digest, m]));
    const toOcr: PDFRef[] = [];
    for (const ref of refs) {
      const s = doc.context.lookup(ref);
      if (!(s instanceof PDFStream)) continue;
      let digest = '';
      try {
        digest = await digestBytes(streamBytes(s));
      } catch {
        /* 展開できない画像は OCR に回す */
      }
      const mine = own.get(digest);
      if (mine && input.original) {
        const [img] = await env.images.decode(input.original.base, [PDFRef.of(mine.objectNumber, mine.generation)]);
        if (img) {
          replaceImage(doc, ref, img);
          images++;
          continue;
        }
      }
      const info = imageInfo(doc, ref);
      if (info && worthOcr(info)) toOcr.push(ref);
    }
    if (toOcr.length && env.images.ocr) {
      const saved = await doc.save({ useObjectStreams: false });
      for (let i = 0; i < toOcr.length; i += 4) {
        const batch = toOcr.slice(i, i + 4);
        const decoded = await env.images.decode(saved, batch);
        for (let k = 0; k < batch.length; k++) {
          const img = decoded[k];
          if (!img) continue;
          const lines = await env.images.ocr.recognize(img);
          const o = ocrText(lines);
          const chars = lines.flatMap((l) => l.chars);
          const groups: PaintGroup[] = [];
          for (const hit of findLabels(o.text, map)) {
            const idx = new Set<number>();
            for (let c = hit.start; c < hit.end; c++) if (o.map[c]! >= 0) idx.add(o.map[c]!);
            const cs = [...idx].map((n) => chars[n]!).filter(Boolean);
            if (!cs.length) continue;
            groups.push({ boxes: [{ x0: Math.min(...cs.map((c) => c.x0)), y0: Math.min(...cs.map((c) => c.y0)), x1: Math.max(...cs.map((c) => c.x1)), y1: Math.max(...cs.map((c) => c.y1)) }], label: hit.original });
          }
          if (groups.length) {
            replaceImage(doc, batch[k]!, await env.images.paint(img, groups));
            images++;
            replaced += groups.length;
          }
        }
      }
    } else if (toOcr.length) {
      notes.push('画像の中のラベルは読み取れない環境のため、戻していません。');
    }
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, fileName: restoredPdfName(input.fileName), replaced, images, unmatched: [...unmatched], notes };
}

/** マスクの土台にした元の PDF。ページごとの文章と、フォントを復元先にコピーする仕組み */
type Original = { model: TextModel; pages: { text: string; map: number[] }[]; font: (ref: PDFRef) => PDFRef };

async function loadOriginal(base: Uint8Array, dest: PDFDocument): Promise<Original | null> {
  try {
    const src = await loadEditable(base);
    const model = buildTextModel(src);
    const byPage: number[][] = Array.from({ length: model.pageCount }, () => []);
    model.glyphs.forEach((g, i) => byPage[g.page]?.push(i));
    const copier = PDFObjectCopier.for(src.context, dest.context);
    const copied = new Map<PDFRef, PDFRef>();
    const font = (ref: PDFRef) => {
      let r = copied.get(ref);
      if (!r) copied.set(ref, (r = copier.copy(ref)));
      return r;
    };
    return { model, pages: byPage.map((indices) => pageText(model.glyphs, indices)), font };
  } catch {
    return null;
  }
}

/**
 * ラベルの位置にあった元の語を、元の PDF から探して1文字ずつ取り出す。
 * 同じ語がページに何度も出るときは、ラベルの書き出しの点にいちばん近いものを選ぶ。見つからなければ null
 */
export function originalRun(original: Pick<Original, 'model' | 'pages' | 'font'>, label: GlyphRef, word: string): RunGlyph[] | null {
  const page = original.pages[label.page];
  if (!page || !word) return null;
  const glyphs = original.model.glyphs;
  let best: { indices: number[]; d: number } | null = null;
  for (let at = page.text.indexOf(word); at >= 0; at = page.text.indexOf(word, at + 1)) {
    const indices: number[] = [];
    for (let i = at; i < at + word.length; i++) {
      const v = page.map[i]!;
      if (v >= 0 && indices[indices.length - 1] !== v) indices.push(v);
    }
    const g0 = indices.length ? glyphs[indices[0]!]! : null;
    const len = g0 ? Math.hypot(g0.dx, g0.dy) : 0;
    if (!g0 || len < 1e-9) continue;
    const ex = label.x - g0.x;
    const ey = label.y - g0.y;
    const along = Math.abs((ex * g0.dx + ey * g0.dy) / len);
    const across = Math.abs((-ex * g0.dy + ey * g0.dx) / len);
    // ラベルは小さくしたとき少し持ち上げるので、垂直の向きは文字の高さまで許す
    if (along > g0.h * 0.5 || across > g0.h) continue;
    if (!best || along + across < best.d) best = { indices, d: along + across };
  }
  if (!best) return null;

  const g0 = glyphs[best.indices[0]!]!;
  const len = Math.hypot(g0.dx, g0.dy);
  const ux = g0.dx / len;
  const uy = g0.dy / len;
  // ユーザー空間から文字空間への倍率（行の向きと、それに垂直な向き）
  const sAlong = len / Math.abs(g0.adv);
  const sAcross = g0.h / g0.state.size;
  if (!Number.isFinite(sAlong) || !Number.isFinite(sAcross) || sAlong <= 0 || sAcross <= 0) return null;
  const run: RunGlyph[] = [];
  for (const i of best.indices) {
    const g = glyphs[i]!;
    const font = g.state.font;
    const glen = Math.hypot(g.dx, g.dy);
    if (g.vertical || !font?.ref || font.subtype === 'Type3' || !g.state.size || !g.state.th || !Number.isFinite(g.width)) return null;
    // 向きの違う文字（回転した行など）は、同じ行の数値では動かせない
    if (glen > 1e-9 && Math.abs(g.dx * uy - g.dy * ux) / glen > 1e-3) return null;
    const bytes = showBytes(original.model, g);
    if (!bytes) return null;
    const ex = g.x - g0.x;
    const ey = g.y - g0.y;
    run.push({
      font: original.font(font.ref),
      size: g.state.size,
      th: g.state.th,
      tr: g.state.tr,
      bytes,
      along: (ex * ux + ey * uy) / sAlong,
      rise: g0.state.ts + (-ex * uy + ey * ux) / sAcross,
      advance: (g.width / 1000) * g.state.size * g.state.th,
    });
  }
  return run;
}

/** 文字を描いた命令の中の、その文字のバイト列 */
function showBytes(model: TextModel, g: GlyphRef): Uint8Array | null {
  const o = model.units[g.unit]?.ops[g.op];
  if (!o) return null;
  let t;
  if (o.op === 'TJ' && o.args[0]?.t === 'arr') t = o.args[0].items[g.part];
  else if (o.op === 'Tj' || o.op === "'") t = o.args[0];
  else if (o.op === '"') t = o.args[2];
  return t?.t === 'str' ? t.bytes.slice(g.start, g.end) : null;
}

/**
 * 文字の後ろに続く、何も描かない送り（TJ の数値）の合計（文字空間）と、その間に戻された文字の大きさ。
 * このツールで加工した PDF では、ラベルを書いた後に「元の語の幅」だけ送っているので、それが元の語の場所になる。
 * ほかの PDF ではすぐ次の文字が来るので 0 になる。
 */
export function trailing(model: TextModel, glyphIndex: number): { gap: number; size?: number } {
  const g = model.glyphs[glyphIndex]!;
  const unit = model.units[g.unit]!;
  let size = g.state.size;
  let th = g.state.th;
  let gap = 0;
  let restoredSize: number | undefined;
  const label = g.state.fontName?.startsWith('TCLabel') ?? false;
  const walk = (items: { t: string; v?: number; bytes?: Uint8Array }[]): boolean => {
    for (const it of items) {
      if (it.t === 'num') gap += (-(it.v ?? 0) / 1000) * size * th;
      else if (it.t === 'str' && it.bytes && it.bytes.length) return false;
    }
    return true;
  };
  const first = unit.ops[g.op];
  if (first?.op === 'TJ' && first.args[0]?.t === 'arr' && !walk(first.args[0].items.slice(g.part + 1) as never)) return { gap: Math.max(0, gap) };
  for (let i = g.op + 1; i < unit.ops.length; i++) {
    const o = unit.ops[i]!;
    const n = (k: number) => (o.args[k]?.t === 'num' ? (o.args[k] as { v: number }).v : 0);
    if (o.op === 'Tf') {
      size = n(1);
      if (label && restoredSize === undefined) restoredSize = size;
    } else if (o.op === 'Tz') th = n(0) / 100;
    else if (['Tc', 'Tw', 'Ts', 'Tr', 'TL', 'BMC', 'BDC', 'EMC', 'rg', 'RG', 'g', 'G', 'k', 'K', 'sc', 'scn', 'SC', 'SCN', 'cs', 'CS'].includes(o.op)) continue;
    else if (o.op === 'TJ' && o.args[0]?.t === 'arr') {
      if (!walk(o.args[0].items as never)) break;
    } else if (o.op === 'Tj' && o.args[0]?.t === 'str' && !o.args[0].bytes.length) continue;
    else break;
  }
  return { gap: Math.max(0, gap), size: label && restoredSize && restoredSize > g.state.size ? restoredSize : undefined };
}
