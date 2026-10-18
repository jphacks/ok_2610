// 評価データ（text_cleaner_eval_10000 の samples.jsonl）を規則エンジンで解析し、evaluate.py が読める予測ファイルを書く。
//
//   npx jiti scripts/eval-run.ts samples.jsonl 予測.jsonl [--split dev|test] [--ner NERトークン.jsonl]
//
// --ner には scripts/eval-ner-cache.ts が保存した NER のトークン列を渡す。後処理（ner-post）はここで毎回かける。無ければ規則のみ。
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze, type EngineOutput } from '../src/core/analyze';
import type { Span } from '../src/core/model/types';
import { entitiesToSpans, type NerToken } from '../src/engines/ner-post';

type Sample = { id: string; text: string; split: string };

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const split = opt('--split');
const nerPath = opt('--ner');
const [samplesPath, outPath] = args;
if (!samplesPath || !outPath) {
  console.error('usage: jiti scripts/eval-run.ts samples.jsonl out.jsonl [--split dev|test] [--ner ner.jsonl]');
  process.exit(1);
}

const readJsonl = <T>(p: string): T[] =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

const samples = readJsonl<Sample>(samplesPath).filter((s) => !split || s.split === split);
const ner = new Map<string, Span[]>();
if (nerPath) {
  for (const r of readJsonl<{ id: string; chunks: { offset: number; text: string; tokens: NerToken[] }[] }>(nerPath)) {
    ner.set(r.id, r.chunks.flatMap((c) => entitiesToSpans(c.text, c.tokens, c.offset)));
  }
}

const lines: string[] = [];
const t0 = Date.now();
for (const s of samples) {
  const engineOutputs: EngineOutput[] = nerPath ? [{ engine: 'ner', status: 'ok', ms: 0, spans: ner.get(s.id) ?? [] }] : [];
  const r = await analyze({
    text: s.text,
    settings: {
      stage: 'B',
      purpose: 'summary',
      keep: { relationships: true, dates: true, amounts: true, organizations: false },
      profile: nerPath ? ['rule', 'ner'] : ['rule'],
      customTerms: [],
      includeHistory: false,
    },
    ops: [],
    engineOutputs,
    policy: { status: 'none' },
    conditions: { status: 'unanswered', restricted: [], consult: [] },
  });
  lines.push(
    JSON.stringify({
      id: s.id,
      masked: r.masked,
      restoreMap: r.restoreMap,
      cands: r.candidates.map((c) => ({ start: c.start, end: c.end, text: c.text, categories: c.categories, role: c.role ?? null, output: c.output })),
    }),
  );
}
writeFileSync(outPath, lines.join('\n') + '\n');
console.error(`${samples.length} samples in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outPath}`);
