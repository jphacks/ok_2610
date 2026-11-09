import { PDFDocument, PDFRef, PDFStream } from 'pdf-lib';
import type { ImageEnv, OcrEngine, PaintGroup, Rgba } from './images';
import { getNumber, N } from './objects';

// 画像の取り出し（PDF.js で描く）と塗りつぶし（キャンバス）。ブラウザとテストで同じ処理を使い、キャンバスだけ差し替える（Issue #9・#11）。

type Ctx2D = {
  putImageData(d: unknown, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number };
  createImageData(w: number, h: number): { data: Uint8ClampedArray; width: number; height: number };
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(t: string, x: number, y: number): void;
  measureText(t: string): { width: number };
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  fillStyle: unknown;
  font: string;
  textBaseline: string;
};
export type CanvasLike = { width: number; height: number; getContext(type: '2d'): unknown };

type PdfJs = typeof import('pdfjs-dist');

export type RasterDeps = {
  pdfjs: PdfJs;
  createCanvas(w: number, h: number): CanvasLike;
  /** PDF.js に渡す追加の設定（Worker・CMap・wasm の場所） */
  documentOptions?: () => Record<string, unknown>;
  /** ラベルを描くフォントの family 名（事前に登録しておく） */
  fontFamily: string;
  ocr: OcrEngine | null;
};

/** 描くときに大きすぎる画像は縮めずに断る（キャンバスの上限） */
const MAX_PIXELS = 40_000_000;

export function makeImageEnv(deps: RasterDeps): ImageEnv {
  return {
    ocr: deps.ocr,
    async decode(pdf, refs) {
      if (!refs.length) return [];
      // 画像1枚ずつを、画像の画素数と同じ大きさのページに描いた PDF を作り、PDF.js で描く
      const doc = await PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: false });
      const first = doc.getPageCount();
      const sizes: { w: number; h: number }[] = [];
      for (const ref of refs) {
        const s = doc.context.lookup(ref);
        const w = s instanceof PDFStream ? (getNumber(doc.context, s.dict, 'Width') ?? 0) : 0;
        const h = s instanceof PDFStream ? (getNumber(doc.context, s.dict, 'Height') ?? 0) : 0;
        sizes.push({ w, h });
        const page = doc.addPage([Math.max(w, 1), Math.max(h, 1)]);
        page.node.set(N('Resources'), doc.context.obj({ XObject: { Im0: ref } }));
        page.node.set(N('Contents'), doc.context.register(doc.context.flateStream(`q 1 1 1 rg 0 0 ${w} ${h} re f ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`)));
      }
      const bytes = await doc.save({ useObjectStreams: false });
      const task = deps.pdfjs.getDocument({ data: bytes, ...(deps.documentOptions?.() ?? {}) });
      const out: (Rgba | null)[] = [];
      try {
        const pdfDoc = await task.promise;
        for (let k = 0; k < refs.length; k++) {
          const { w, h } = sizes[k]!;
          if (!w || !h || w * h > MAX_PIXELS) {
            out.push(null);
            continue;
          }
          try {
            const page = await pdfDoc.getPage(first + k + 1);
            const viewport = page.getViewport({ scale: 1 });
            const canvas = deps.createCanvas(w, h);
            const ctx = canvas.getContext('2d') as Ctx2D;
            await page.render({ canvasContext: ctx as never, canvas: canvas as never, viewport }).promise;
            const d = ctx.getImageData(0, 0, w, h);
            out.push({ width: w, height: h, data: new Uint8ClampedArray(d.data) });
            page.cleanup();
          } catch {
            out.push(null);
          }
        }
      } finally {
        await task.destroy();
      }
      return out;
    },
    async paint(image, groups) {
      return paintGroups(deps, image, groups);
    },
  };
}

/** 箱を背景に近い色で塗り、最初の箱にラベルを書く。PDF の画像と画像ファイル（Issue #11）で共通 */
export function paintGroups(deps: Pick<RasterDeps, 'createCanvas' | 'fontFamily'>, image: Rgba, groups: PaintGroup[]): Rgba {
  const canvas = deps.createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d') as Ctx2D;
  const id = ctx.createImageData(image.width, image.height);
  id.data.set(image.data);
  ctx.putImageData(id, 0, 0);
  for (const g of groups) {
    g.boxes.forEach((b, i) => {
      const h = b.y1 - b.y0;
      const pad = Math.max(1, Math.round(h * 0.12));
      const x0 = Math.max(0, Math.floor(b.x0 - pad));
      const y0 = Math.max(0, Math.floor(b.y0 - pad));
      const x1 = Math.min(image.width, Math.ceil(b.x1 + pad));
      const y1 = Math.min(image.height, Math.ceil(b.y1 + pad));
      const bg = borderColor(image, x0, y0, x1, y1);
      ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      if (i !== 0 || !g.label) return;
      const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
      ctx.fillStyle = lum > 140 ? 'rgb(0,0,0)' : 'rgb(255,255,255)';
      const size = Math.max(6, (y1 - y0) * 0.8);
      ctx.font = `${size}px "${deps.fontFamily}"`;
      ctx.textBaseline = 'middle';
      const width = ctx.measureText(g.label).width;
      const room = x1 - x0;
      ctx.save();
      ctx.translate(x0, (y0 + y1) / 2);
      if (width > room && width > 0) ctx.scale(room / width, 1);
      ctx.fillText(g.label, 0, 0);
      ctx.restore();
    });
  }
  const d = ctx.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(d.data) };
}

/** 箱のまわり1画素の色の中央値（背景の色とみなす） */
function borderColor(img: Rgba, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const take = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const p = (y * img.width + x) * 4;
    rs.push(img.data[p]!);
    gs.push(img.data[p + 1]!);
    bs.push(img.data[p + 2]!);
  };
  for (let x = x0 - 1; x <= x1; x++) {
    take(x, y0 - 1);
    take(x, y1);
  }
  for (let y = y0; y < y1; y++) {
    take(x0 - 1, y);
    take(x1, y);
  }
  const med = (a: number[]) => (a.length ? a.sort((p, q) => p - q)[a.length >> 1]! : 255);
  return [med(rs), med(gs), med(bs)];
}

export { PDFRef };
