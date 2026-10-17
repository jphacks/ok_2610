import { expect, test } from 'vitest';
import { mergeSpans } from '../../src/core/detect/merge';
import type { Span } from '../../src/core/model/types';
import { TIER } from '../../src/core/model/types';

const span = (start: number, end: number, category: Span['category'], tier: Span['tier']): Span => ({
  start, end, category, tier, source: tier === TIER.ner ? 'ner' : 'rule', certainty: '推定', evidence: [],
});

test('同じ範囲は1候補にまとめ、分類を並べる', () => {
  const m = mergeSpans([span(0, 5, 'url', TIER.certainRule), span(0, 5, 'confidential', TIER.certainRule)], 10);
  expect(m).toHaveLength(1);
  expect(m[0]?.categories).toEqual(['url', 'confidential']);
});

test('重なりは優先順位の高い方を採る', () => {
  const m = mergeSpans([span(2, 8, 'personName', TIER.ner), span(0, 5, 'phone', TIER.certainRule)], 10);
  expect(m.map((s) => [s.start, s.end])).toEqual([[0, 5]]);
});

test('ヒューリスティックの部分一致は、それを含むモデルの span が置き換える', () => {
  const m = mergeSpans([span(0, 6, 'orgName', TIER.heuristicRule), span(0, 12, 'orgName', TIER.ner)], 20);
  expect(m.map((s) => [s.start, s.end])).toEqual([[0, 12]]);
});

test('範囲外・幅ゼロ・非整数の span は捨てる', () => {
  expect(mergeSpans([span(-1, 3, 'phone', 0), span(4, 4, 'phone', 0), span(1.5, 3, 'phone', 0), span(8, 30, 'phone', 0)], 10)).toEqual([]);
});
