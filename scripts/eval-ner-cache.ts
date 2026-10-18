// 評価データの全件に NER を Node で実行し、トークン列を保存する（後処理 ner-post を変えても再実行しなくてよいように生のまま）。
//
//   npx jiti scripts/eval-ner-cache.ts samples.jsonl ner-tokens.jsonl モデルのあるフォルダ
//
// モデルのあるフォルダ: models/ を含むフォルダ（npm run setup:ner 後の public/ や、展開した拡張のフォルダ）
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { env, pipeline } from '@huggingface/transformers';
import { chunkText, type NerToken } from '../src/engines/ner-post';
import { NER_MODEL_ID } from '../src/engines/ner';

const [samplesPath, outPath, root] = process.argv.slice(2);
if (!samplesPath || !outPath || !root) {
  console.error('usage: jiti scripts/eval-ner-cache.ts samples.jsonl out.jsonl <folder containing models/>');
  process.exit(1);
}
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${root.replace(/[\\/]$/, '')}/models/`;

type Classifier = (text: string, options: { ignore_labels: string[] }) => Promise<NerToken[]>;
const classify = (await pipeline('token-classification', NER_MODEL_ID, { dtype: 'q8' })) as unknown as Classifier;

const done = new Set<string>();
if (existsSync(outPath)) for (const l of readFileSync(outPath, 'utf8').split('\n')) if (l.trim()) done.add((JSON.parse(l) as { id: string }).id);

const samples = readFileSync(samplesPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { id: string; text: string })
  .filter((s) => !done.has(s.id));

const t0 = Date.now();
let n = 0;
for (const s of samples) {
  const chunks = [];
  for (const chunk of chunkText(s.text)) {
    if (!chunk.text.trim()) continue;
    const tokens = await classify(chunk.text, { ignore_labels: [] });
    chunks.push({ offset: chunk.offset, text: chunk.text, tokens: tokens.map(({ entity, score, index, word }) => ({ entity, score, index, word })) });
  }
  appendFileSync(outPath, JSON.stringify({ id: s.id, chunks }) + '\n');
  if (++n % 500 === 0) console.error(`${n}/${samples.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.error(`done ${n} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
