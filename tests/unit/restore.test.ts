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

test('一般化した語を、元の語が1つに決まるときは原文に戻す', () => {
  const { restored, replacedCount, generalized, unmatched } = restoreLabels('人物Aは30代で東京都に住んでいる。2020年代の話。', { 人物A: '佐藤' }, { '30代': '34歳', 東京都: '東京都港区', '2020年': '2020年5月3日' });
  expect(restored).toBe('佐藤は34歳で東京都港区に住んでいる。2020年代の話。');
  expect(replacedCount).toBe(3);
  expect(generalized).toEqual([
    { from: '30代', to: '34歳' },
    { from: '東京都', to: '東京都港区' },
  ]);
  expect(unmatched).toEqual([]);
});

test('一般化した語の対応表は、元の語が1つに決まり、ほかの所に同じ語がないものだけ', async () => {
  const r = await run('佐藤花子さん（34歳）と鈴木一郎さん（36歳）が来店しました。');
  for (const [g, original] of Object.entries(r.generalizedMap)) {
    expect(r.masked).toContain(g);
    expect(r.text).toContain(original);
  }
  expect(r.generalizedMap['30代']).toBeUndefined();
});
