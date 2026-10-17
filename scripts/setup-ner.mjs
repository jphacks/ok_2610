// NER の実行に必要な同梱物を public/ に配置する。
// - ONNX Runtime の WASM（Transformers.js は既定で CDN から読むため、同梱して読込み先を固定する。LP-01）
// - 変換済みモデルの有無を確認する（無ければ scripts/convert-ner.py の実行を案内する）
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ortDist = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const ortOut = path.join(root, 'public', 'ort');
const files = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

mkdirSync(ortOut, { recursive: true });
for (const f of files) {
  const src = path.join(ortDist, f);
  if (!existsSync(src)) {
    console.error(`見つかりません: ${src}（npm install を実行してください）`);
    process.exit(1);
  }
  copyFileSync(src, path.join(ortOut, f));
}
console.log(`ONNX Runtime の WASM を配置しました: ${ortOut}`);

const modelDir = path.join(root, 'public', 'models', 'tsmatz', 'xlm-roberta-ner-japanese');
const manifestPath = path.join(modelDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('NER モデルがありません。次を実行してください:\n  python3 -m venv .venv-ner && .venv-ner/bin/pip install "optimum[onnxruntime]" torch\n  .venv-ner/bin/python scripts/convert-ner.py');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const [rel, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(readFileSync(path.join(modelDir, rel))).digest('hex');
  if (actual !== expected) {
    console.error(`モデルのハッシュが一致しません: ${rel}`);
    process.exit(1);
  }
}
console.log(`NER モデルを確認しました（revision ${manifest.revision}）`);
