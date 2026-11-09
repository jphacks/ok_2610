import type { OutputSegment } from '../../core/model/types';
import { restoreLabels as restoreText } from '../../core/restore';
import { faceLabel, faceNotes, type FaceBox, type FaceDetector } from '../face';
import { ocrText, type OcrChar, type OcrEngine, type PaintGroup, type Rgba } from '../pdf/images';
import { changedSpans, digestBytes, lineBoxes, MANUAL_LABEL } from '../pdf/mask';
import { findLabels } from '../pdf/restore';

// 画像ファイル（PNG・JPEG など）の中の文字を OCR で読み、隠す語を塗りつぶしてラベルを書き、元に戻す（Issue #11）。
// PDF の中の画像の処理（Issue #9）と同じ部品を使う: OCR（ocr.ts）・文字のつなぎ方（ocrText）・塗り方（paintGroups）・ラベルの探し方（findLabels）。
// 画素の取り出し（デコード）と書き出しは環境ごとに違う（ブラウザは createImageBitmap、テストは Node 用キャンバス）ので、ImageFileEnv で受け取る。

/** 読み込める画像の拡張子 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'] as const;
/** これより大きいファイルは開かない（Excel・CSV・PDF と同じ） */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** これより画素の多い画像は読まない（OCR とキャンバスが現実的に扱える大きさ） */
export const MAX_IMAGE_PIXELS = 25_000_000;

export function isImageFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface ImageFileEnv {
  /** 画像ファイルを、そのままの画素数の RGBA にする（向きの情報は反映し、透明な所は白にする） */
  decode(bytes: Uint8Array): Promise<Rgba>;
  /** RGBA を PNG にする（ファイル情報は書かない） */
  encode(image: Rgba): Promise<Uint8Array>;
  /** 箱を背景に近い色で塗り、ラベルを書く */
  paint(image: Rgba, groups: PaintGroup[]): Promise<Rgba>;
  ocr: OcrEngine | null;
  /** 顔の検出器。null なら顔は探さない（保存・復元では使わない） */
  faces?: FaceDetector | null;
}

export type ImageSource = {
  kind: 'image';
  fileName: string;
  /** 読み込んだ画像の画素。マスクの土台。原文と同じくメモリにだけ置く */
  base: Rgba;
  text: string;
  /** 文章の各文字の出どころ: 0 以上は OCR の文字（ocrChars）の番号、-1 は区切り */
  charMap: Int32Array;
  ocrChars: OcrChar[];
  /** 見つけた顔。保存するときは、利用者が残すと選んだもの以外を塗りつぶす */
  faces: FaceBox[];
  width: number;
  height: number;
  notes: string[];
};

/** 利用者が画像の上に描いた、手動で隠す四角形（画素、左上が原点） */
export type ImageRect = { x0: number; y0: number; x1: number; y1: number };

export type MaskedImage = {
  bytes: Uint8Array;
  fileName: string;
  notes: string[];
  /** 書き出した PNG の指紋。復元で、自分が加工した画像かを見分けるのに使う。メモリにだけ置く */
  digest: string;
};

export class ImageImportError extends Error {
  override name = 'ImageImportError';
}
export class ImageExportError extends Error {
  override name = 'ImageExportError';
}
export class ImageRestoreError extends Error {
  override name = 'ImageRestoreError';
}

const stem = (fileName: string) => {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
};
/** 加工後は PNG で書き出す（JPEG の再圧縮でにじませず、ファイル情報も持ち込まない） */
export const maskedImageName = (fileName: string) => `${stem(fileName)}_加工済み.png`;
export const restoredImageName = (fileName: string) => `${stem(fileName).replace(/_加工済み$/, '')}_復元済み.png`;

export async function importImage(fileName: string, bytes: Uint8Array, env: ImageFileEnv): Promise<ImageSource> {
  if (!isImageFile(fileName)) throw new ImageImportError('対応していない画像の形式です（PNG・JPEG・WebP・BMP に対応しています）。');
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageImportError(`ファイルが大きすぎます（上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB）。`);
  if (!env.ocr) throw new ImageImportError('画像の中の文字を読み取れない環境です。');
  let base: Rgba;
  try {
    base = await env.decode(bytes);
  } catch (e) {
    if (e instanceof ImageImportError) throw e;
    throw new ImageImportError('画像を読めませんでした。ファイルが壊れていないか確認してください。');
  }
  if (!base.width || !base.height) throw new ImageImportError('画像を読めませんでした。');
  if (base.width * base.height > MAX_IMAGE_PIXELS) throw new ImageImportError(`画像が大きすぎます（${base.width}×${base.height}、上限 ${MAX_IMAGE_PIXELS / 1_000_000} 百万画素）。`);

  const lines = await env.ocr.recognize(base);
  const o = ocrText(lines);
  const faces = env.faces ? await env.faces.detect(base) : [];
  // 文字がなくても顔があれば取り込む（顔写真だけの画像）。本文は空にせず、見出しだけを置く
  if (!o.text.trim() && !faces.length) throw new ImageImportError('画像から文字も顔も見つかりませんでした。');
  const text = o.text.trim() ? o.text : IMAGE_ONLY_TEXT;
  const ocrChars = lines.flatMap((l) => l.chars);
  return {
    kind: 'image',
    fileName,
    base,
    text,
    charMap: o.text.trim() ? Int32Array.from(o.map) : new Int32Array(text.length).fill(-1),
    ocrChars,
    faces,
    width: base.width,
    height: base.height,
    notes: [
      ...faceNotes(faces, !!env.faces),
      '画像の中の文字は端末内の OCR で読んでいます。読み違えた文字は検出から漏れることがあるので、「画像の仕上がりを確認」で確かめてください。',
      '撮影日時・位置などのファイル情報（EXIF）は取り込まず、保存する画像にも書きません。',
    ],
  };
}

/** 文字の見つからない画像の本文。検査する文字はないが、顔を隠して保存できるように取り込む */
export const IMAGE_ONLY_TEXT = '【画像（文字なし）】';

/**
 * 加工後の文章（segments）を、画像の上で塗りつぶしとラベルとして反映する。
 * 見つけた顔は、keptFaces（残すと選んだ顔の番号）以外を塗りつぶす
 */
export async function exportMaskedImage(src: ImageSource, segments: OutputSegment[], env: ImageFileEnv, rects: ImageRect[] = [], keptFaces: number[] = []): Promise<MaskedImage> {
  const text = segments.map((s) => (s.kind === 'changed' ? s.original : s.text)).join('');
  if (text !== src.text) throw new ImageExportError('読み込んだ画像と本文が一致しないため、画像としては保存できません。');

  const groups: PaintGroup[] = [];
  for (const sp of changedSpans(segments)) {
    const idx: number[] = [];
    for (let i = sp.start; i < sp.end; i++) {
      const v = src.charMap[i]!;
      if (v >= 0 && idx[idx.length - 1] !== v) idx.push(v);
    }
    const chars = idx.map((k) => src.ocrChars[k]!).filter(Boolean);
    if (chars.length) groups.push({ boxes: lineBoxes(chars), label: sp.label });
  }
  const notes: string[] = [];
  const textGroups = groups.length;
  let faces = 0;
  src.faces.forEach((f, i) => {
    if (keptFaces.includes(i)) return;
    groups.push({ boxes: [f], label: faceLabel(i) });
    faces++;
  });
  let manual = 0;
  for (const r of rects) {
    const box = clampRect(r, src.width, src.height);
    if (!box) continue;
    groups.push({ boxes: [box], label: MANUAL_LABEL });
    manual++;
  }
  const painted = groups.length ? await env.paint(src.base, groups) : src.base;
  const bytes = await env.encode(painted);
  if (textGroups) notes.push(`画像の中の ${textGroups} 箇所を塗りつぶし、ラベルを書き込みました。`);
  if (faces) notes.push(`顔 ${faces} 件を塗りつぶしました。`);
  if (keptFaces.length) notes.push(`残すと選んだ顔が ${keptFaces.length} 件あります。`);
  if (manual) notes.push(`手動で囲んだ ${manual} 箇所を塗りつぶしました。`);
  notes.push('PNG 形式で保存します。撮影日時・位置などのファイル情報は含みません。');
  return { bytes, fileName: maskedImageName(src.fileName), notes, digest: await digestBytes(bytes) };
}

function clampRect(r: ImageRect, width: number, height: number): ImageRect | null {
  const x0 = Math.max(0, Math.min(r.x0, r.x1));
  const x1 = Math.min(width, Math.max(r.x0, r.x1));
  const y0 = Math.max(0, Math.min(r.y0, r.y1));
  const y1 = Math.min(height, Math.max(r.y0, r.y1));
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x0, y0, x1, y1 } : null;
}

export type ImageRestoreInput = {
  fileName: string;
  bytes: Uint8Array;
  restoreMap: Record<string, string>;
  generalizedMap: Record<string, string>;
  /** 加工の土台にした元の画像と、書き出した画像の指紋。自分が加工した画像なら元の画素に戻す */
  original?: { base: Rgba; digest: string | null };
};

export type ImageRestoreResult = { bytes: Uint8Array; fileName: string; replaced: number; images: number; unmatched: string[]; notes: string[] };

/**
 * AIなどから戻ってきた画像の中のラベルを、元の語に戻す。
 * このパネルで加工して保存した画像そのものなら元の画素に戻し、それ以外は OCR でラベルを探して元の語を描き込む。
 */
export async function restoreImage(input: ImageRestoreInput, env: ImageFileEnv): Promise<ImageRestoreResult> {
  const fileName = restoredImageName(input.fileName);
  if (input.original?.digest && (await digestBytes(input.bytes)) === input.original.digest) {
    return { bytes: await env.encode(input.original.base), fileName, replaced: 0, images: 1, unmatched: [], notes: ['加工して保存した画像だったため、元の画像に戻しました。'] };
  }
  if (!env.ocr) throw new ImageRestoreError('画像の中の文字を読み取れない環境です。');
  let img: Rgba;
  try {
    img = await env.decode(input.bytes);
  } catch {
    throw new ImageRestoreError('画像を読めませんでした。');
  }
  if (img.width * img.height > MAX_IMAGE_PIXELS) throw new ImageRestoreError('画像が大きすぎます。');
  const lines = await env.ocr.recognize(img);
  const o = ocrText(lines);
  const chars = lines.flatMap((l) => l.chars);
  const map = { ...input.generalizedMap, ...input.restoreMap };
  const groups: PaintGroup[] = [];
  for (const hit of findLabels(o.text, map)) {
    const cs: OcrChar[] = [];
    for (let c = hit.start; c < hit.end; c++) {
      const v = o.map[c]!;
      if (v >= 0 && chars[v] && cs[cs.length - 1] !== chars[v]) cs.push(chars[v]);
    }
    if (!cs.length) continue;
    groups.push({ boxes: [{ x0: Math.min(...cs.map((c) => c.x0)), y0: Math.min(...cs.map((c) => c.y0)), x1: Math.max(...cs.map((c) => c.x1)), y1: Math.max(...cs.map((c) => c.y1)) }], label: hit.original });
  }
  const unmatched = restoreText(o.text, input.restoreMap, input.generalizedMap).unmatched;
  if (!groups.length) return { bytes: new Uint8Array(), fileName, replaced: 0, images: 0, unmatched, notes: [] };
  const bytes = await env.encode(await env.paint(img, groups));
  return {
    bytes,
    fileName,
    replaced: groups.length,
    images: 1,
    unmatched,
    notes: ['画像の中のラベルを OCR で探して、元の語を描き込みました。読み違えたラベルは戻らないことがあります。'],
  };
}
