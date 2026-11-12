import { EncryptedPDFError, PDFDocument, PDFRef } from 'pdf-lib';
import { faceNotes, type FaceBox } from '../face';
import { imageInfo, ocrText, worthOcr, type ImageEnv, type OcrChar } from './images';
import { liftInlineImages } from './inline';
import { flattenAnnotations } from './sanitize';
import { buildTextModel, pageText, type TextModel } from './textmodel';

// PDF を読み込み、解析用の文章と「文章の各文字が PDF のどこから来たか」の対応を作る（Issue #9）。
// 注釈は本文に焼き込んでから読む。マスク・復元はこのとき保存した base（焼き込み後の PDF）を土台にする。

export const MAX_PAGES = 300;
/** OCR にかける画像の上限。超えた分は検査できないので、PDF としては保存しない */
export const MAX_OCR_IMAGES = 60;

export type PdfImageEntry = {
  objectNumber: number;
  generation: number;
  page: number;
  width: number;
  height: number;
  ocr: boolean;
};

export type PdfSource = {
  kind: 'pdf';
  fileName: string;
  /** 注釈を焼き込んだ後の PDF。マスクの土台。原文と同じくメモリにだけ置く */
  base: Uint8Array;
  text: string;
  /** 文章の各文字の出どころ: 0 以上は文字（glyph）の番号、-1 は区切り・見出し、-2 以下は OCR の文字（-2 - 番号） */
  charMap: Int32Array;
  ocrChars: (OcrChar & { image: number })[];
  images: PdfImageEntry[];
  /** 画像の中に見つけた顔（Issue #11）。image は images の番号、box は画像の画素 */
  faces: { image: number; box: FaceBox }[];
  pageCount: number;
  /** PDF として保存できない理由。空なら保存できる */
  blockers: string[];
  notes: string[];
};

export class PdfImportError extends Error {
  override name = 'PdfImportError';
}

const imgRef = (e: PdfImageEntry) => PDFRef.of(e.objectNumber, e.generation);
export { imgRef };

export async function loadEditable(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) throw new PdfImportError('暗号化された PDF は、PDF の形のままでは加工できません。');
    throw new PdfImportError('PDF の構造を読めませんでした。');
  }
}

export type ImportProgress = (done: number, total: number) => void;

export async function importPdf(fileName: string, bytes: Uint8Array, env: ImageEnv | null, onProgress?: ImportProgress): Promise<PdfSource> {
  const original = await loadEditable(bytes);
  const flattened = flattenAnnotations(original);
  // 本文に直接埋め込まれた画像（履歴書の顔写真など）を、ふつうの画像にして OCR・顔の検出・塗りつぶしの対象にする
  liftInlineImages(original);
  const base = await original.save({ useObjectStreams: false, updateFieldAppearances: false });
  const doc = await loadEditable(base);
  const model = buildTextModel(doc, MAX_PAGES);
  const notes: string[] = [];
  const blockers: string[] = [];
  if (flattened) notes.push(`注釈・フォームの表示（${flattened} 件）は本文に焼き込んで検査しました。コメントの吹き出しの中身などは出力に含めません。`);
  if (doc.getPageCount() > MAX_PAGES) blockers.push(`${MAX_PAGES} ページを超える PDF は、PDF としては保存できません。`);

  // 画像: 最初に出てくるページで1度だけ OCR にかける
  const seen = new Set<string>();
  const images: PdfImageEntry[] = [];
  for (const pl of model.images) {
    if (seen.has(pl.ref.tag)) continue;
    seen.add(pl.ref.tag);
    const info = imageInfo(doc, pl.ref);
    if (!info) continue;
    images.push({ objectNumber: pl.ref.objectNumber, generation: pl.ref.generationNumber, page: pl.page, width: info.width, height: info.height, ocr: worthOcr(info) });
  }
  const targets = images.filter((i) => i.ocr);
  const ocrResults = new Map<number, Awaited<ReturnType<NonNullable<ImageEnv['ocr']>['recognize']>>>();
  const faces: PdfSource['faces'] = [];
  if (targets.length) {
    if (!env?.ocr) blockers.push('画像の中の文字を読み取れない環境のため、画像を含む PDF は PDF としては保存できません。');
    else if (targets.length > MAX_OCR_IMAGES) blockers.push(`画像が多すぎます（${targets.length} 枚、上限 ${MAX_OCR_IMAGES} 枚）。画像の文字を検査しきれないため、PDF としては保存できません。`);
    else {
      let done = 0;
      onProgress?.(0, targets.length);
      // デコードは数枚ずつ（大きなスキャン画像でメモリを使いすぎないように）
      for (let i = 0; i < targets.length; i += 4) {
        const batch = targets.slice(i, i + 4);
        const decoded = await env.decode(base, batch.map(imgRef));
        for (let k = 0; k < batch.length; k++) {
          const img = decoded[k];
          const entry = batch[k]!;
          if (!img) {
            blockers.push(`${entry.page + 1} ページの画像を読めませんでした。`);
            continue;
          }
          ocrResults.set(images.indexOf(entry), await env.ocr.recognize(img));
          if (env.faces) for (const box of await env.faces.detect(img)) faces.push({ image: images.indexOf(entry), box });
          onProgress?.(++done, targets.length);
        }
      }
    }
  }

  // 文章を組み立てる
  let text = '';
  const map: number[] = [];
  const ocrChars: PdfSource['ocrChars'] = [];
  const push = (s: string, m: number[]) => {
    text += s;
    map.push(...m);
  };
  const glyphsByPage: number[][] = Array.from({ length: model.pageCount }, () => []);
  model.glyphs.forEach((g, i) => glyphsByPage[g.page]?.push(i));
  let unknown = 0;
  let emptyPages = 0;
  for (let p = 0; p < model.pageCount; p++) {
    const body = pageText(model.glyphs, glyphsByPage[p]!);
    unknown += body.unknown;
    if (text) push('\n\n', [-1, -1]);
    const head = `【ページ ${p + 1}】\n`;
    push(head, Array(head.length).fill(-1));
    push(body.text, body.map);
    let hasText = !!body.text.trim();
    images.forEach((img, idx) => {
      if (img.page !== p) return;
      const lines = ocrResults.get(idx);
      if (!lines) return;
      const o = ocrText(lines);
      if (!o.text.trim()) return;
      hasText = true;
      const base0 = ocrChars.length;
      for (const line of lines) for (const ch of line.chars) ocrChars.push({ ...ch, image: idx });
      const h = `\n\n【ページ ${p + 1}・画像 ${images.filter((x, j) => x.page === p && j <= idx).length}】\n`;
      push(h, Array(h.length).fill(-1));
      push(o.text, o.map.map((v) => (v < 0 ? -1 : -2 - (base0 + v))));
    });
    if (!hasText) emptyPages++;
  }
  if (!text.replace(/【ページ \d+】/g, '').trim()) throw new PdfImportError('PDF から文字を取り出せませんでした。');

  for (const i of model.issues) {
    const msg = `${i.page + 1} ページ: ${i.message}`;
    if (i.kind === 'font') blockers.push(`${msg}。この文字は検査できないため、PDF としては保存できません。`);
    else notes.push(msg);
  }
  if (unknown) notes.push(`文字の対応が分からない記号が ${unknown} 個あり、検査していません（箇条書きの記号などのことが多いです）。`);
  if (emptyPages) notes.push(`文字の見つからないページが ${emptyPages} ページあります。`);
  if (targets.length && env?.ocr && targets.length <= MAX_OCR_IMAGES) notes.push(...faceNotes(faces, !!env.faces));
  return { kind: 'pdf', fileName, base, text, charMap: Int32Array.from(map), ocrChars, images, faces, pageCount: doc.getPageCount(), blockers: [...new Set(blockers)], notes };
}

export type { TextModel };
