import { expect, test } from 'vitest';
import { FORBIDDEN_PHRASES, MESSAGES } from '../../src/core/explain/messages';
import { demoEmail, run } from './helpers';

test('画面文言と理由説明に断定表現を使わない（FR-17）', async () => {
  const r = await run(demoEmail);
  const texts = [
    ...Object.values(MESSAGES),
    ...Object.values(r.explanations).flatMap((e) => [e.what, ...e.why, e.ifKept, ...e.alternatives, ...e.notes]),
    ...r.risks.flatMap((f) => [...f.reasons, ...f.suggestions.map((s) => s.effect)]),
    ...r.recommendation.reasons,
  ];
  for (const phrase of FORBIDDEN_PHRASES) {
    expect(texts.filter((t) => t.includes(phrase))).toEqual([]);
  }
});
