// PDF の中の画像を、アプリと同じ取り込み・デコードで PNG にする（eval-pdf-faces.ts が使う）。
//   npx tsx scripts/eval-pdf-photo.ts 履歴書.pdf 写真.png   （1枚目の画像を書き出して目で確かめる）
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import { imgRef, importPdf } from '../src/infra/pdf/document';
import { makeImageEnv } from '../src/infra/pdf/raster';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
pdfjsLegacy.GlobalWorkerOptions.workerSrc = pathToFileURL(join(pdfjsRoot, 'legacy/build/pdf.worker.mjs')).href;
export const env = makeImageEnv({
  pdfjs: pdfjsLegacy as unknown as typeof import('pdfjs-dist'),
  createCanvas: (w, h) => createCanvas(w, h) as never,
  documentOptions: () => ({ cMapUrl: join(pdfjsRoot, 'cmaps') + '/', cMapPacked: true, wasmUrl: join(pdfjsRoot, 'wasm') + '/' }),
  fontFamily: 'sans-serif',
  ocr: null as never,
});

export async function photos(path: string) {
  const src = await importPdf(path, new Uint8Array(readFileSync(path)), null);
  const imgs = await env.decode(src.base, src.images.map(imgRef));
  return imgs.map((img) => {
    if (!img) return null;
    const c = createCanvas(img.width, img.height);
    c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    return c.encodeSync('png');
  });
}

if (process.argv[1]?.endsWith('eval-pdf-photo.ts')) {
  const [pdf, out] = process.argv.slice(2);
  const [png] = await photos(pdf!);
  writeFileSync(out!, png!);
}
