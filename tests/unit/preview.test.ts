import { describe, expect, test } from 'vitest';
import { previewAction } from '../../src/core/transform/preview';
import { demoEmail, run } from './helpers';

const find = async (text: string) => {
  const r = await run(demoEmail);
  const c = r.candidates.find((x) => x.text === text);
  if (!c) throw new Error(`候補がありません: ${text}`);
  return { r, c };
};

describe('処理ごとの仕上がりの見本（Issue #29）', () => {
  test('生年月日は年代・年・月まで・削除の仕上がりを出し、そのままは原文', async () => {
    const { c } = await find('1958年4月12日');
    expect(previewAction(c, { kind: 'generalize', level: 'decade' })).toBe('1950年代');
    expect(previewAction(c, { kind: 'generalize', level: 'year' })).toBe('1958年');
    expect(previewAction(c, { kind: 'generalize', level: 'month' })).toBe('1958年4月');
    expect(previewAction(c, { kind: 'delete' })).toBe('');
    expect(previewAction(c, { kind: 'keep' })).toBe('1958年4月12日');
    // 日付の中の数字を年齢として読んだ「190代」のような見本は出さない
    expect(previewAction(c, { kind: 'generalize', level: 'ageBand' })).toBeNull();
  });

  test('その語に効かない処理は出さない（氏名の年代化・一部だけ隠す）', async () => {
    const { c } = await find('佐藤花子');
    expect(previewAction(c, { kind: 'generalize', level: 'decade' })).toBeNull();
    expect(previewAction(c, { kind: 'partialMask', visible: 4 })).toBeNull();
  });

  test('仮の名前は今の対象のラベル、電話番号は末尾だけ残す', async () => {
    const { r, c } = await find('佐藤花子');
    const entity = r.entities.find((e) => e.id === c.entityId);
    expect(previewAction(c, { kind: 'pseudonym' }, entity?.label)).toBe(entity?.label);
    const { c: phone } = await find('090-1234-5678');
    expect(previewAction(phone, { kind: 'partialMask', visible: 4 })).toBe('***-****-5678');
  });
});

describe('理由の見出しは実際の仕上がりで書く', () => {
  test('固定の例（1980年代 など）ではなく、この語の仕上がりを書く', async () => {
    const { r, c } = await find('1958年4月12日');
    const what = r.explanations[c.id]!.what;
    expect(what).toContain('「1950年代」');
    expect(what).not.toContain('1980年代');
  });
});
