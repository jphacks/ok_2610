import { ensureCanvasFont, LABEL_FONT_FAMILY, openOcr } from '../pdf/browser';
import type { Rgba } from '../pdf/images';
import { paintGroups } from '../pdf/raster';
import { MAX_IMAGE_PIXELS, ImageImportError, type ImageFileEnv } from './image';

// サイドパネルで画像ファイルを読み・加工・復元するときの環境（Issue #11）。OCR とラベルのフォントは PDF と同じく拡張に同梱したものを使う。
// OCR の Worker は処理ごとに起こし、終わったら止める（原文を残さない）。

export type BrowserImageEnv = ImageFileEnv & { dispose(): Promise<void> };

const createCanvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** ocr=false なら OCR を起こさない（保存・仕上がりの確認用） */
export async function openImageEnv(options: { ocr?: boolean } = {}): Promise<BrowserImageEnv> {
  await ensureCanvasFont();
  const ocr = options.ocr !== false ? await openOcr() : null;
  return {
    ocr,
    async decode(bytes) {
      // 向き（EXIF の Orientation）は反映し、色の変換はしない。ファイル情報は画素に移らない
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      try {
        const { width, height } = bitmap;
        if (width * height > MAX_IMAGE_PIXELS) throw new ImageImportError(`画像が大きすぎます（${width}×${height}、上限 ${MAX_IMAGE_PIXELS / 1_000_000} 百万画素）。`);
        const c = new OffscreenCanvas(width, height);
        const ctx = c.getContext('2d')!;
        // 透明な所は白にする（OCR が背景を黒と読まないように）
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0);
        const d = ctx.getImageData(0, 0, width, height);
        return { width, height, data: new Uint8ClampedArray(d.data) };
      } finally {
        bitmap.close();
      }
    },
    async encode(img) {
      const c = new OffscreenCanvas(img.width, img.height);
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    },
    async paint(image, groups) {
      return paintGroups({ createCanvas, fontFamily: LABEL_FONT_FAMILY }, image, groups);
    },
    async dispose() {
      await ocr?.terminate();
    },
  };
}

/** 仕上がりの確認用に、画像を表示できる URL にする。使い終わったら revokeObjectURL で解放する */
export function pngUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
}

export type { Rgba };
