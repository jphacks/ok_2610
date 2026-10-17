import { expect, test } from 'vitest';
import { evaluateConditions, QUESTIONS, type Answer } from '../../src/core/conditions';

const all = (a: Answer): Record<string, Answer> => Object.fromEntries(QUESTIONS.map((q) => [q.id, a]));
const noRestriction = (): Record<string, Answer> => Object.fromEntries(QUESTIONS.map((q) => [q.id, q.restrictiveAnswer === 'yes' ? 'no' : 'yes']));

test('「不明」は許可にならず、確認事項を一覧にする（FR-16）', () => {
  const r = evaluateConditions({ ...noRestriction(), rules: 'unknown' });
  expect(r.status).toBe('unknown');
  expect(r.consult).toHaveLength(1);
});

test('制約ありの回答があれば restricted', () => {
  expect(evaluateConditions(all('unknown')).status).toBe('unknown');
  expect(evaluateConditions({ rules: 'yes' }).status).toBe('restricted');
});

test('すべて制約なしでも「自己申告で確認済み」まで（許可とはしない）', () => {
  expect(evaluateConditions(noRestriction()).status).toBe('selfDeclaredOk');
});
