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

test('元の語が複数ある一般化は、元の語ごとに区別したラベルにして戻せる', async () => {
  const text =
    '株式会社東都ソリューションズ\n営業部 田中健一様\n\n株式会社みらいテクノロジーの佐藤美咲です。\n' +
    '今回のプロジェクトは、情報システム部で入社7年目となる私が担当しております。\n\n株式会社みらいテクノロジー\n情報システム部 主任\n佐藤 美咲\n';
  const r = await run(text);
  expect(r.masked).not.toContain('ある部署');
  expect(r.masked).not.toContain('ある企業');
  const label = (original: string) => Object.entries(r.restoreMap).find(([, o]) => o === original)?.[0];
  const sales = label('営業部');
  const system = label('情報システム部');
  expect(sales).toMatch(/^部署[A-Z]+$/);
  expect(system).toMatch(/^部署[A-Z]+$/);
  expect(sales).not.toBe(system);
  // 同じ原文は、どこに出ても同じラベルになる
  expect(r.masked.split(system!).length - 1).toBe(2);
  expect(label('株式会社東都ソリューションズ')).toMatch(/^組織[A-Z]+$/);
  expect(label('株式会社みらいテクノロジー')).toMatch(/^組織[A-Z]+$/);

  const { restored, unmatched } = restoreLabels(`${system}から、${sales}へご連絡します。`, r.restoreMap, r.generalizedMap);
  expect(restored).toBe('情報システム部から、営業部へご連絡します。');
  expect(unmatched).toEqual([]);
});

test('意味のある一般化は、その語に記号を付けて区別する', async () => {
  const r = await run('佐藤花子さん（34歳）と鈴木一郎さん（36歳）が来店しました。');
  const ages = Object.entries(r.restoreMap).filter(([l]) => l.startsWith('30代'));
  expect(ages.map(([l]) => l).sort()).toEqual(['30代A', '30代B']);
  const { restored } = restoreLabels('30代Aと30代Bの方', r.restoreMap, r.generalizedMap);
  expect(restored).toContain('34');
  expect(restored).toContain('36');
});
