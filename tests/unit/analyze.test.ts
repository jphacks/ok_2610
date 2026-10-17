import { describe, expect, test } from 'vitest';
import type { EngineOutput } from '../../src/core/analyze';
import { resolvePolicy } from '../../src/core/policy';
import { demoEmail, run, settings } from './helpers';

const byText = (r: Awaited<ReturnType<typeof run>>, text: string) => r.candidates.filter((c) => c.text === text);

describe('デモの問合せメール', () => {
  test('AT-01: 氏名・メール・電話が加工後に残らない', async () => {
    const r = await run(demoEmail);
    for (const s of ['佐藤花子', 'hanako.sato@example.com', '090-1234-5678', '美しが丘', 'AB-20261003-1182']) {
      expect(r.masked).not.toContain(s);
    }
    expect(r.recheck.filter((f) => f.kind === 'residual')).toEqual([]);
  });

  test('同じ人物は同じ仮ラベル（署名の氏名にも広げる）', async () => {
    const r = await run(demoEmail);
    const sato = byText(r, '佐藤花子');
    expect(sato.length).toBe(2);
    expect(new Set(sato.map((c) => c.output))).toEqual(new Set(['人物A']));
    expect(byText(r, '田中').every((c) => c.output === '人物B')).toBe(true);
  });

  test('AT-03: 生年月日は一般化し、注文日・配達日は段階 B で残す', async () => {
    const r = await run(demoEmail);
    expect(byText(r, '1958年4月12日')[0]).toMatchObject({ role: 'birthDate', output: '1950年代' });
    expect(byText(r, '10月3日')[0]).toMatchObject({ role: 'businessDate', output: '10月3日' });
    expect(byText(r, '10月20日')[0]).toMatchObject({ role: 'businessDate', output: '10月20日' });
  });

  test('AT-02: 組合せの理由と追加加工の提案を出し、段階 C をすすめる', async () => {
    const r = await run(demoEmail);
    expect(r.risks[0]?.level).toBe('要注意');
    expect(r.risks[0]?.reasons.join('')).toContain('照合はしていません');
    expect(r.risks[0]?.suggestions.length).toBeGreaterThan(0);
    expect(r.recommendation.stage).toBe('C');
  });

  test('段階を強めても、表に出る原情報は増えない（FR-13）', async () => {
    const [a, b, c] = await Promise.all((['A', 'B', 'C'] as const).map((stage) => run(demoEmail, { settings: settings({ stage }) })));
    const kept = (r: typeof a) => new Set(r!.candidates.filter((x) => x.output === x.text).map((x) => x.id));
    const ka = kept(a), kb = kept(b), kc = kept(c);
    expect([...kb].every((id) => ka.has(id))).toBe(true);
    expect([...kc].every((id) => kb.has(id))).toBe(true);
  });
});

describe('手動修正と再検査', () => {
  test('AT-04: 置換語に氏名を入れると再検査で警告し、確認単位が変わる', async () => {
    const base = await run(demoEmail);
    const target = byText(base, '090-1234-5678')[0]!;
    const edited = await run(demoEmail, {
      ops: [{ kind: 'setAction', start: target.start, end: target.end, action: { kind: 'replace', text: '鈴木一郎様の携帯' } }],
    });
    expect(edited.recheck.some((f) => f.kind === 'newDetection' && f.text.includes('鈴木'))).toBe(true);
    expect(edited.contentId).not.toBe(base.contentId);
  });

  test('解除は操作単位で効き、元の候補が見つからなければ衝突として返す', async () => {
    const base = await run(demoEmail);
    const tanaka = byText(base, '田中')[0]!;
    const r = await run(demoEmail, { ops: [{ kind: 'release', start: tanaka.start, end: tanaka.end }, { kind: 'release', start: 0, end: 1 }] });
    expect(r.candidates.find((c) => c.id === tanaka.id)).toMatchObject({ output: '田中', manual: true });
    expect(r.opIssues).toEqual([expect.objectContaining({ opIndex: 1, kind: 'conflict' })]);
  });

  test('未検出の範囲を手動で追加でき、同じ語の残りは再検査で知らせる', async () => {
    const at = demoEmail.indexOf('電動ベッド');
    const r = await run(demoEmail, { ops: [{ kind: 'add', start: at, end: at + 5, category: 'custom' }] });
    expect(r.masked.startsWith('件名：先日購入した[指定語1]の配送')).toBe(true);
    expect(r.recheck).toContainEqual(expect.objectContaining({ kind: 'residual', text: '電動ベッド' }));
  });
});

describe('安全な停止（SF-02）', () => {
  test('認証情報は解除できず、残っていれば出力を止める', async () => {
    const text = 'APIキーは sk-proj-abcdefghijklmnopqrstuvwx です';
    const base = await run(text);
    const key = base.candidates.find((c) => c.categories.includes('credential'))!;
    expect(base.masked).not.toContain('sk-proj');
    const r = await run(text, { ops: [{ kind: 'release', start: key.start, end: key.end }] });
    expect(r.opIssues[0]?.kind).toBe('rejected');
    expect(r.masked).not.toContain('sk-proj');
  });

  test('検査プロファイル内のエンジンが失敗したら出力を止め、評価不能にする', async () => {
    const ner: EngineOutput = { engine: 'ner', status: 'unavailable', reason: 'モデル未配置', ms: 0, spans: [] };
    const r = await run(demoEmail, { settings: settings({ profile: ['rule', 'ner'] }), engineOutputs: [ner] });
    expect(r.blockers.some((b) => b.kind === 'engineFailed')).toBe(true);
    expect(r.risks[0]?.level).toBe('評価不能');
  });

  test('空入力は解析せず止める', async () => {
    expect((await run('  ')).blockers.map((b) => b.kind)).toContain('empty');
  });
});

describe('組織ポリシー（FR-18, AT-09）', () => {
  const now = '2026-10-17T00:00:00Z';
  test('読込み失敗・期限切れは個人設定へ弱めず停止する', async () => {
    const expired = resolvePolicy({ version: '1', expiresAt: '2026-01-01' }, now);
    expect(expired.status).toBe('error');
    expect((await run(demoEmail, { policy: expired })).blockers.some((b) => b.kind === 'policy')).toBe(true);
  });

  test('最低段階と解除禁止を適用し、利用条件が不明なら止める', async () => {
    const policy = resolvePolicy({ version: '2026.10', minStage: 'C', lockedCategories: ['personName'], requireConditions: true }, now);
    const base = await run(demoEmail, { policy });
    expect(base.candidates.find((c) => c.categories.includes('sensitive'))?.output).toBe('補助具');
    const sato = byText(base, '佐藤花子')[0]!;
    const r = await run(demoEmail, { policy, ops: [{ kind: 'release', start: sato.start, end: sato.end }], conditions: { status: 'unknown', restricted: [], consult: [] } });
    expect(r.opIssues[0]?.kind).toBe('rejected');
    expect(r.blockers.some((b) => b.kind === 'conditions')).toBe(true);
  });
});

test('確認単位: 同じ入力なら同じ ID、設定が変われば別の ID（FR-22）', async () => {
  const a = await run(demoEmail);
  const b = await run(demoEmail);
  const c = await run(demoEmail, { settings: settings({ stage: 'C' }) });
  expect(a.contentId).toBe(b.contentId);
  expect(c.contentId).not.toBe(a.contentId);
});
