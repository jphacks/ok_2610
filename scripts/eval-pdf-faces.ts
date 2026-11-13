// 履歴書の写真で顔が見つかるかを数える。顔の検出器（MediaPipe）はブラウザでしか動かないので、Playwright の Chromium で
// アプリと同じ検出器・設定・切り出し（eval-pdf-faces-page.ts）を動かす。写真はアプリと同じ取り込み・デコードで取り出す。
//
//   npx tsx scripts/eval-pdf-faces.ts <PDF のフォルダ> faces.jsonl [--every N]   （N 件に1件だけ調べる。途中から再開できる）
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { photos } from './eval-pdf-photo';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const every = args.includes('--every') ? Number(args.splice(args.indexOf('--every'), 2)[1]) : 1;
const [root, out] = args;
const files: string[] = [];
for (const d of readdirSync(root!, { withFileTypes: true })) if (d.isDirectory()) for (const f of readdirSync(join(root!, d.name))) if (f.endsWith('.pdf')) files.push(join(root!, d.name, f));
files.sort();
const done = new Set<string>();
if (existsSync(out!)) for (const l of readFileSync(out!, 'utf8').split('\n')) if (l.trim()) done.add((JSON.parse(l) as { id: string }).id);

const bundle = await build({ entryPoints: [join(import.meta.dirname, 'eval-pdf-faces-page.ts')], bundle: true, write: false, format: 'iife', platform: 'browser' });
const wasmDir = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
const model = readFileSync(join(import.meta.dirname, '../vendor/mediapipe/blaze_face_short_range.tflite'));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route('http://eval.local/**', async (route) => {
  const p = new URL(route.request().url()).pathname;
  if (p === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/app.js"></script>' });
  if (p === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0]!.text });
  if (p === '/model.tflite') return route.fulfill({ body: model });
  if (p.startsWith('/wasm/')) {
    const f = join(wasmDir, p.slice(6));
    return route.fulfill({ body: readFileSync(f), contentType: f.endsWith('.js') ? 'text/javascript' : 'application/wasm' });
  }
  return route.fulfill({ status: 404 });
});
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text().slice(0, 200)); });
await page.goto('http://eval.local/');
await page.evaluate(() => (window as unknown as { init: () => Promise<boolean> }).init());
const t0 = Date.now();
let n = 0;
for (const [i, f] of files.entries()) {
  if (i % every) continue;
  const id = f.slice(root!.length + 1).split(sep).join('/');
  if (done.has(id)) continue;
  const pngs = await photos(f);
  const faces = [];
  for (const png of pngs) {
    if (!png) { faces.push(null); continue; }
    faces.push(await page.evaluate((b64) => (window as unknown as { detect: (s: string) => Promise<unknown> }).detect(b64), png.toString('base64')));
  }
  appendFileSync(out!, JSON.stringify({ id, faces }) + '\n');
  if (++n % 500 === 0) console.error(n, ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
await browser.close();
console.error('done', n);
