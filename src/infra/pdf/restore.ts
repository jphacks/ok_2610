import fontkit from '@pdf-lib/fontkit';
import { PDFRef, PDFStream } from 'pdf-lib';
import { restoreLabels as restoreText } from '../../core/restore';
import { loadEditable, PdfImportError } from './document';
import { imageInfo, ocrText, replaceImage, worthOcr, type PaintGroup } from './images';
import { digestBytes, splitLines, type PdfEnv } from './mask';
import { streamBytes } from './objects';
import { applyPieces, PdfEditError, type Piece } from './rewrite';
import { flattenAnnotations } from './sanitize';
import { buildTextModel, pageText } from './textmodel';

// AIなどから戻ってきた PDF の中のラベルを、元の語に戻す（Issue #9）。
// 文字のラベルは、その位置・幅のまま元の語に書き換える。自分がマスクした画像は元の画素に戻し、
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

export class PdfRestoreError extends Error {}

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
  const font = await doc.embedFont(await env.labelFont(), { subset: true });
  const model = buildTextModel(doc);
  const map = { ...input.generalizedMap, ...input.restoreMap };
  const notes: string[] = [];

  // ---- 文字 ----
  const pieces: Piece[] = [];
  let replaced = 0;
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
      splitLines(model, glyphs).forEach((line, k) => pieces.push({ glyphs: line, text: k === 0 ? hit.original : '' }));
      replaced++;
    }
  }
  try {
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
