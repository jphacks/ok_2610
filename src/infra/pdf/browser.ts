import { assetUrl, readBundledAsset } from '../assets';
import { openFaceDetector } from '../face-browser';
import { tesseractOcr } from '../ocr';
import type { PdfEnv } from './mask';
import { makeImageEnv } from './raster';

// サイドパネルで PDF を加工・復元するときの環境。使う部品はすべて拡張に同梱したもの（wxt.config.ts）で、外部には取りに行かない。
// PDF.js の Worker と OCR の Worker は処理ごとに起こし、終わったら止める（原文を残さない）。

const asset = assetUrl;
export const LABEL_FONT_FAMILY = 'TCLabelFont';
const FONT_PATH = 'fonts/label.ttf';

let fontReady: Promise<void> | null = null;
/** ラベルを描くフォントをキャンバスで使えるようにする（PDF の画像と画像ファイルで共通） */
export function ensureCanvasFont(): Promise<void> {
  fontReady ??= (async () => {
    const face = new FontFace(LABEL_FONT_FAMILY, `url(${asset(FONT_PATH)})`);
    await face.load();
    document.fonts.add(face);
  })().catch((e) => {
    fontReady = null;
    throw e;
  });
  return fontReady;
}

let fontBytes: Promise<Uint8Array> | null = null;
const loadFontBytes = () => (fontBytes ??= readBundledAsset(FONT_PATH));

export type BrowserPdfEnv = PdfEnv & { dispose(): Promise<void> };

export type BrowserOcr = ReturnType<typeof tesseractOcr>;

/** 端末内の OCR（同梱の Tesseract）を起こす。使い終わったら terminate で止める */
export async function openOcr(): Promise<BrowserOcr> {
  const mod = await import('tesseract.js');
  const tesseract = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod;
  return tesseractOcr({
    tesseract,
    encode: async (img) => {
      const c = new OffscreenCanvas(img.width, img.height);
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      return c.convertToBlob({ type: 'image/png' });
    },
    workerOptions: { workerPath: asset('ocr/worker.min.js'), corePath: asset('ocr'), langPath: asset('ocr'), workerBlobURL: false },
  });
}

/** ocr=false なら OCR を起こさない（画像の文字を読まない処理用） */
export async function openPdfEnv(options: { ocr?: boolean } = {}): Promise<BrowserPdfEnv> {
  const pdfjs = await import('pdfjs-dist');
  const port = new Worker(new URL('../../worker/pdf.worker.ts', import.meta.url), { type: 'module' });
  // 型定義では port が null 扱いだが、実装は Worker を受け取る
  const worker = new pdfjs.PDFWorker({ port: port as unknown as null });
  await ensureCanvasFont();
  const ocr = options.ocr !== false ? await openOcr() : null;
  // 顔の検出器は読み込むときだけ使う。使えない環境では顔を探さない（取込結果に表示する）
  const faces = options.ocr !== false ? await openFaceDetector().catch(() => null) : null;
  const images = makeImageEnv({
    pdfjs,
    createCanvas: (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    },
    documentOptions: () => ({ worker, cMapUrl: asset('pdf-cmaps/'), cMapPacked: true, wasmUrl: asset('pdf-wasm/'), disableFontFace: false }),
    fontFamily: LABEL_FONT_FAMILY,
    ocr,
    faces,
  });
  return {
    labelFont: loadFontBytes,
    images,
    async dispose() {
      faces?.close();
      await ocr?.terminate();
      worker.destroy();
      port.terminate();
    },
  };
}

/** 仕上がりの確認用に、PDF のページを画像にする */
export async function renderPdfPages(bytes: Uint8Array, width: number, maxPages: number): Promise<{ url: string; width: number; height: number; toPdf: (x: number, y: number) => [number, number] }[]> {
  const pdfjs = await import('pdfjs-dist');
  const port = new Worker(new URL('../../worker/pdf.worker.ts', import.meta.url), { type: 'module' });
  const worker = new pdfjs.PDFWorker({ port: port as unknown as null });
  const task = pdfjs.getDocument({ data: bytes.slice(), worker, cMapUrl: asset('pdf-cmaps/'), cMapPacked: true, wasmUrl: asset('pdf-wasm/') });
  try {
    const doc = await task.promise;
    const out = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d')!, canvas, viewport }).promise;
      out.push({ url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, toPdf: (x: number, y: number) => viewport.convertToPdfPoint(x, y) as [number, number] });
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
    worker.destroy();
    port.terminate();
  }
}
