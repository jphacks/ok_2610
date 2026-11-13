// PDF から取り出した履歴書の文章（eval-pdf-extract.ts の texts.jsonl）を、PDF のまま保存するときと同じ設定
// （既定の設定・隠す語はすべてラベル）で解析し、正解（eval-resume-truth.ts）と突き合わせる。
//
//   npx tsx scripts/eval-resume-pdf.ts texts.jsonl [--ner ner.jsonl] [--out 結果フォルダ] [--limit 件数]
//
// --ner が無ければ規則だけ（NER を使えない環境と同じ）。結果フォルダに次を書く:
//   summary.txt   項目ごとに、全部隠れた・一部だけ隠れた・まったく隠れなかった割合、型ごとの内訳、正解にない箇所を隠したもの（隠しすぎの候補）
//   misses.jsonl  隠しきれなかった箇所（どこまで隠れたかを ■ で示す）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { analyze, type EngineOutput } from '../src/core/analyze';
import type { Span } from '../src/core/model/types';
import { DEFAULT_PREFS } from '../src/infra/storage';
import { entitiesToSpans, type NerToken } from '../src/engines/ner-post';
import { truth, type Field } from './eval-resume-truth';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const nerPath = opt('--ner');
const outDir = opt('--out') ?? '.eval/out';
const limit = Number(opt('--limit') ?? 0);
const [textsPath] = args;
mkdirSync(outDir, { recursive: true });

const readJsonl = <T>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
let docs = readJsonl<{ id: string; text: string }>(textsPath!);
if (limit) docs = docs.slice(0, limit);
const ner = new Map<string, Span[]>();
if (nerPath && existsSync(nerPath)) {
  for (const r of readJsonl<{ id: string; chunks: { offset: number; text: string; tokens: NerToken[] }[] }>(nerPath)) {
    ner.set(r.id, r.chunks.flatMap((c) => entitiesToSpans(c.text, c.tokens, c.offset)));
  }
  docs = docs.filter((d) => ner.has(d.id));
}

type Stat = { total: number; full: number; partial: number; none: number };
const blank = (): Stat => ({ total: 0, full: 0, partial: 0, none: 0 });
const byField = new Map<Field, Stat>();
const byFolderField = new Map<string, Stat>();
const misses: string[] = [];
const fps = new Map<string, number>();
const fpExamples = new Map<string, string>();
let docsAllHidden = 0;
let maskedChars = 0;
let fpChars = 0;
const t0 = Date.now();

for (const d of docs) {
  const engineOutputs: EngineOutput[] = nerPath ? [{ engine: 'ner', status: 'ok', ms: 0, spans: ner.get(d.id) ?? [] }] : [];
  const r = await analyze({
    text: d.text,
    settings: {
      labelsOnly: true,
      stage: DEFAULT_PREFS.stage,
      purpose: DEFAULT_PREFS.purpose,
      keep: DEFAULT_PREFS.keep,
      profile: nerPath ? ['rule', 'ner'] : ['rule'],
      customTerms: [],
      includeHistory: false,
    },
    ops: [],
    engineOutputs,
    policy: { status: 'none' },
    conditions: { status: 'unanswered', restricted: [], consult: [] },
  });
  const hidden = new Uint8Array(d.text.length);
  const masked = r.candidates.filter((c) => c.output !== c.text);
  for (const c of masked) hidden.fill(1, c.start, c.end);
  const gt = truth(d.text);
  const inTruth = new Uint8Array(d.text.length);
  for (const t of gt) inTruth.fill(1, t.start, t.end);
  const folder = d.id.slice(0, d.id.indexOf('/'));
  let allHidden = true;
  for (const t of gt) {
    let n = 0;
    let h = 0;
    for (let k = t.start; k < t.end; k++) {
      if (/\s/.test(d.text[k]!)) continue;
      n++;
      h += hidden[k]!;
    }
    const kind = h === n ? 'full' : h === 0 ? 'none' : 'partial';
    for (const key of [t.field, `${folder}\t${t.field}`]) {
      const map = (key.includes('\t') ? byFolderField : byField) as Map<string, Stat>;
      if (!map.has(key)) map.set(key, blank());
      const st = map.get(key)!;
      st.total++;
      st[kind]++;
    }
    if (kind !== 'full') {
      allHidden = false;
      const shown = [...t.text].map((ch, k) => (hidden[t.start + k] ? '■' : ch)).join('');
      const line = d.text.slice(d.text.lastIndexOf('\n', t.start - 1) + 1, d.text.indexOf('\n', t.end) < 0 ? undefined : d.text.indexOf('\n', t.end));
      misses.push(JSON.stringify({ id: d.id, field: t.field, kind, text: t.text, shown, line }));
    }
  }
  if (allHidden) docsAllHidden++;
  // 正解にない箇所を隠したもの（隠しすぎの候補）
  for (const c of masked) {
    maskedChars += c.end - c.start;
    let overlap = false;
    for (let k = c.start; k < c.end; k++) if (inTruth[k]) overlap = true;
    if (overlap) continue;
    fpChars += c.end - c.start;
    const key = `${c.categories.join('+')}\t${c.text.replace(/[0-9０-９]/g, '0')}`;
    fps.set(key, (fps.get(key) ?? 0) + 1);
    if (!fpExamples.has(key)) fpExamples.set(key, `${d.id}: ${d.text.slice(Math.max(0, c.start - 15), c.end + 15).replace(/\n/g, '⏎')}`);
  }
}

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(2) : '-');
const lines: string[] = [];
lines.push(`docs ${docs.length}  all-hidden docs ${docsAllHidden} (${pct(docsAllHidden, docs.length)}%)  ${((Date.now() - t0) / 1000).toFixed(0)}s  ner=${!!nerPath}`);
lines.push(`masked chars outside truth: ${fpChars}/${maskedChars} (${pct(fpChars, maskedChars)}%)`);
lines.push('field\ttotal\tfull%\tpartial%\tnone%');
let T = 0;
let F = 0;
for (const [f, s] of [...byField].sort()) {
  T += s.total;
  F += s.full;
  lines.push(`${f}\t${s.total}\t${pct(s.full, s.total)}\t${pct(s.partial, s.total)}\t${pct(s.none, s.total)}`);
}
lines.push(`ALL\t${T}\t${pct(F, T)}`);
lines.push('', '--- folder x field (full% < 100 only)');
for (const [k, s] of [...byFolderField].sort()) if (s.full < s.total) lines.push(`${k}\t${s.total}\t${pct(s.full, s.total)}\t${pct(s.partial, s.total)}\t${pct(s.none, s.total)}`);
lines.push('', '--- top masked outside truth');
for (const [k, n] of [...fps].sort((a, b) => b[1] - a[1]).slice(0, 80)) lines.push(`${n}\t${k}\t${fpExamples.get(k)}`);
writeFileSync(`${outDir}/summary.txt`, lines.join('\n') + '\n');
writeFileSync(`${outDir}/misses.jsonl`, misses.join('\n') + '\n');
console.log(lines.slice(0, 22).join('\n'));
