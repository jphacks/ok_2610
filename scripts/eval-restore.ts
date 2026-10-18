// evaluate_restore.py make が作った回答（JSONL）をアプリの restore に通し、score に渡す結果（JSON）を書く。
//
//   npx jiti scripts/eval-restore.ts 回答.jsonl 復元結果.json
import { readFileSync, writeFileSync } from 'node:fs';
import { restoreLabels } from '../src/core/restore';

const [answersPath, outPath] = process.argv.slice(2);
if (!answersPath || !outPath) {
  console.error('usage: jiti scripts/eval-restore.ts answers.jsonl restored.json');
  process.exit(1);
}

type Answer = { id: string; variant: string; answer: string; restoreMap: Record<string, string> };
const answers = readFileSync(answersPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Answer);

const out = answers.map((a) => {
  const r = restoreLabels(a.answer, a.restoreMap);
  return { id: a.id, variant: a.variant, restored: r.restored, replacedCount: r.replacedCount, unmatched: r.unmatched };
});
writeFileSync(outPath, JSON.stringify(out));
console.error(`${out.length} answers -> ${outPath}`);
