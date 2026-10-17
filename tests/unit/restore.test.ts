import { expect, test } from 'vitest';
import { restoreLabels } from '../../src/core/restore';
import { demoEmail, run } from './helpers';

test('AIの回答の仮ラベルを原文の語に戻す', async () => {
  const r = await run(demoEmail);
  const answer = '人物Aは[注文番号1]の配達日を確認したい。担当は人物B。連絡先は[電話番号1]。';
  const { restored, unmatched } = restoreLabels(answer, r.restoreMap);
  expect(restored).toBe('佐藤花子はAB-20261003-1182の配達日を確認したい。担当は田中。連絡先は090-1234-5678。');
  expect(unmatched).toEqual([]);
});

test('長いラベルを先に置き換え、AIが書き換えたラベルは一覧で返す', () => {
  const map = { 人物A: '佐藤', 人物AB: '鈴木' };
  const { restored, unmatched } = restoreLabels('人物ABと人物Aと人物Cと[電話番号9]', map);
  expect(restored).toBe('鈴木と佐藤と人物Cと[電話番号9]');
  expect(unmatched).toEqual(['人物C', '[電話番号9]']);
});
