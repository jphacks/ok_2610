import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, GlobalFonts, ImageData } from '@napi-rs/canvas';
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import Tesseract from 'tesseract.js';
import { tesseractOcr } from '../../src/infra/ocr';
import type { Rgba } from '../../src/infra/pdf/images';
import type { PdfEnv } from '../../src/infra/pdf/mask';
import { makeImageEnv } from '../../src/infra/pdf/raster';

// テスト用の環境: Node 用の PDF.js・キャンバス・Tesseract で、ブラウザと同じ処理を通す

const require = createRequire(import.meta.url);
export const FONT_PATH = require.resolve('@expo-google-fonts/biz-udpgothic/400Regular/BIZUDPGothic_400Regular.ttf');
export const JP_FONT = readFileSync(FONT_PATH);
GlobalFonts.registerFromPath(FONT_PATH, 'TCLabelFont');

const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
pdfjsLegacy.GlobalWorkerOptions.workerSrc = pathToFileURL(join(pdfjsRoot, 'legacy/build/pdf.worker.mjs')).href;
const pdfjs = pdfjsLegacy as unknown as typeof import('pdfjs-dist');

export function toPng(img: Rgba): Buffer {
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c.encodeSync('png');
}

export const ocr = tesseractOcr({
  tesseract: Tesseract,
  encode: async (img) => toPng(img),
  workerOptions: { langPath: join(dirname(require.resolve('@tesseract.js-data/jpn/package.json')), '4.0.0_best_int') },
});

export const imageEnv = makeImageEnv({
  pdfjs,
  createCanvas: (w, h) => createCanvas(w, h) as never,
  documentOptions: () => ({ cMapUrl: join(pdfjsRoot, 'cmaps') + '/', cMapPacked: true, wasmUrl: join(pdfjsRoot, 'wasm') + '/' }),
  fontFamily: 'TCLabelFont',
  ocr,
});

export const fullEnv: PdfEnv = { labelFont: async () => new Uint8Array(JP_FONT), images: imageEnv };
export const textOnlyEnv: PdfEnv = { labelFont: async () => new Uint8Array(JP_FONT), images: null };

/** 日本語の文字を描いた画像（PNG） */
export function textImage(lines: string[], size = 28): Buffer {
  const w = 640;
  const h = Math.round(size * 1.8 * lines.length + size);
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000000';
  ctx.font = `${size}px TCLabelFont`;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, size * 0.6, size * 0.5 + i * size * 1.8));
  return c.encodeSync('png');
}
