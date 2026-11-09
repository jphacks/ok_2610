import { PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFDocument } from 'pdf-lib';
import { zlibSync } from 'fflate';
import { getName, getNumber, N } from './objects';
import type { FaceDetector } from '../face';

// PDF の中の画像を取り出して OCR にかけ、マスクした画素で差し替える（Issue #9・#11 共通の画像マスク）。
// 画素の取り出し（デコード）と描画は環境ごとに違う（ブラウザは OffscreenCanvas、テストは Node 用キャンバス）ので、ImageEnv で受け取る。

export type Rgba = { width: number; height: number; data: Uint8ClampedArray };

/** OCR で読んだ1文字。座標は画像の画素（左上が原点） */
export type OcrChar = { text: string; x0: number; y0: number; x1: number; y1: number };
export type OcrLine = { chars: OcrChar[] };

export interface OcrEngine {
  recognize(image: Rgba): Promise<OcrLine[]>;
}

/** マスクする箇所。boxes を塗り、最初の箱に label を書く */
export type PaintGroup = { boxes: { x0: number; y0: number; x1: number; y1: number }[]; label: string };

export interface ImageEnv {
  /** PDF（バイト列）の中の画像を、そのままの画素数で RGBA にする */
  decode(pdf: Uint8Array, refs: PDFRef[]): Promise<(Rgba | null)[]>;
  /** 箱を背景に近い色で塗り、ラベルを書く */
  paint(image: Rgba, groups: PaintGroup[]): Promise<Rgba>;
  ocr: OcrEngine | null;
  /** 顔の検出器（Issue #11）。null なら顔は探さない */
  faces?: FaceDetector | null;
}

export type ImageInfo = { ref: PDFRef; width: number; height: number; imageMask: boolean };

/** OCR にかける価値のある大きさか（小さなアイコン・罫線は除く） */
export function worthOcr(info: ImageInfo): boolean {
  return info.width >= 24 && info.height >= 12 && info.width * info.height >= 2000;
}

export function imageInfo(doc: PDFDocument, ref: PDFRef): ImageInfo | null {
  const s = doc.context.lookup(ref);
  if (!(s instanceof PDFStream)) return null;
  const ctx = doc.context;
  return {
    ref,
    width: getNumber(ctx, s.dict, 'Width') ?? 0,
    height: getNumber(ctx, s.dict, 'Height') ?? 0,
    imageMask: ctx.lookup(s.dict.get(N('ImageMask'))) ? String(ctx.lookup(s.dict.get(N('ImageMask')))) === 'true' : false,
  };
}

/** 画像の行の文字をつなげて文章にする。英数字の語の間には空白を入れる */
export function ocrText(lines: OcrLine[]): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let idx = 0;
  lines.forEach((line, li) => {
    if (li > 0) {
      text += '\n';
      map.push(-1);
    }
    let prev: OcrChar | undefined;
    for (const ch of line.chars) {
      if (prev) {
        const gap = ch.x0 - prev.x1;
        const h = Math.max(prev.y1 - prev.y0, ch.y1 - ch.y0, 1);
        if (gap > h * 0.45 && /[\x21-\x7e]$/.test(prev.text) && /^[\x21-\x7e]/.test(ch.text)) {
          text += ' ';
          map.push(-1);
        }
      }
      for (let k = 0; k < ch.text.length; k++) map.push(idx);
      text += ch.text;
      idx++;
      prev = ch;
    }
  });
  return { text, map };
}

/** 差し替える画像の中身を作る。元が型（ImageMask）なら1ビットの型のまま、それ以外は RGB で書く */
export function replaceImage(doc: PDFDocument, ref: PDFRef, img: Rgba) {
  const ctx = doc.context;
  const old = ctx.lookup(ref);
  if (!(old instanceof PDFStream)) return;
  const isMask = getName(ctx, old.dict, 'ImageMask') !== undefined || String(ctx.lookup(old.dict.get(N('ImageMask')))) === 'true';
  const dict = ctx.obj({}) as PDFDict;
  const keep = ['Type', 'Subtype', 'Interpolate', 'Intent', 'SMask', 'OC'];
  for (const [k, v] of old.dict.entries()) if (keep.includes(k.decodeText())) dict.set(k, v);
  dict.set(N('Type'), N('XObject'));
  dict.set(N('Subtype'), N('Image'));
  dict.set(N('Width'), PDFNumber.of(img.width));
  dict.set(N('Height'), PDFNumber.of(img.height));
  dict.set(N('Filter'), N('FlateDecode'));
  let raw: Uint8Array;
  if (isMask) {
    // 型: 0 のビットが塗られる。暗い画素を塗る
    const rowBytes = Math.ceil(img.width / 8);
    raw = new Uint8Array(rowBytes * img.height).fill(0xff);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const p = (y * img.width + x) * 4;
        const lum = 0.299 * img.data[p]! + 0.587 * img.data[p + 1]! + 0.114 * img.data[p + 2]!;
        if (lum < 128) raw[y * rowBytes + (x >> 3)]! &= ~(0x80 >> (x & 7));
      }
    }
    dict.set(N('ImageMask'), ctx.obj(true));
    dict.set(N('BitsPerComponent'), PDFNumber.of(1));
  } else {
    raw = new Uint8Array(img.width * img.height * 3);
    for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
      raw[j] = img.data[i]!;
      raw[j + 1] = img.data[i + 1]!;
      raw[j + 2] = img.data[i + 2]!;
    }
    dict.set(N('ColorSpace'), N('DeviceRGB'));
    dict.set(N('BitsPerComponent'), PDFNumber.of(8));
  }
  ctx.assign(ref, PDFRawStream.of(dict, zlibSync(raw)));
}

/** 画素の中身の指紋。自分がマスクした画像を、復元のときに見分けるのに使う */
export async function rgbaDigest(img: Rgba): Promise<string> {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, img.width);
  new DataView(head.buffer).setUint32(4, img.height);
  const buf = new Uint8Array(head.length + img.data.length);
  buf.set(head);
  buf.set(img.data, head.length);
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export { PDFName };
