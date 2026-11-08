import { describe, expect, test } from 'vitest';
import { toHour, UsageEventSchema } from '../../shared/usage-event';
import { reportingTarget, resolvePolicy } from '../../src/core/policy';
import { summarizeUsage, usageDestination } from '../../src/core/usage';
import { demoEmail, run } from './helpers';

const PII = ['佐藤花子', '田中', '090-1234-5678', 'hanako.sato@example.com', 'AB-20261003-1182', '美しが丘', '1958', '横浜', '渋谷'];

function completeEvent(core: ReturnType<typeof summarizeUsage>) {
  return { schemaVersion: 1, eventId: '6f1c7a0e-1d2b-4c3d-8e9f-0a1b2c3d4e5f', occurredHour: '2026-10-18T03:00Z', extensionVersion: '0.5.0', policyVersion: '2026-10', department: 'sales', ...core };
}

describe('利用記録の中身（SERVER_DESIGN.md §1）', () => {
  test('デモ文から種類ごとの件数だけを取り出し、原文の語を一切含まない', async () => {
    const r = await run(demoEmail);
    const core = summarizeUsage(r, { kind: 'output', stage: 'B', purpose: 'summary', manualOps: 0, destination: 'copy' });
    expect(core.masked.personName).toBe(4);
    expect(core.masked.phone).toBe(1);
    expect(core.kept.date).toBe(2);
    expect(core.riskLevel).toBe('要注意');
    const json = JSON.stringify(UsageEventSchema.parse(completeEvent(core)));
    for (const s of PII) expect(json).not.toContain(s);
  });

  test('未知の項目（本文など）を足した記録は拒否する', async () => {
    const core = summarizeUsage(await run(demoEmail), { kind: 'output', stage: 'B', purpose: 'summary', manualOps: 0, destination: 'copy' });
    expect(UsageEventSchema.safeParse({ ...completeEvent(core), text: demoEmail }).success).toBe(false);
    expect(UsageEventSchema.safeParse({ ...completeEvent(core), engines: { ner: 'ok', nano: 'ok', note: '佐藤' } }).success).toBe(false);
  });

  test('部署・版に日本語や長い文字列は入れられず、件数は 20 で頭打ち', () => {
    const base = completeEvent(summarizeUsage({ candidates: [], risks: [], blockers: [], engines: [] }, { kind: 'output', stage: 'A', purpose: 'reply', manualOps: 99, destination: 'copy' }));
    expect(base.manualOps).toBe(20);
    expect(UsageEventSchema.safeParse({ ...base, department: '営業部の佐藤' }).success).toBe(false);
    expect(UsageEventSchema.safeParse({ ...base, policyVersion: 'x'.repeat(33) }).success).toBe(false);
    expect(UsageEventSchema.safeParse({ ...base, masked: { personName: 21 } }).success).toBe(false);
  });

  test('停止の記録は、記録対象の理由（認証情報など）だけを持ち、出力先を持たない', async () => {
    const r = await run('APIキーは sk-proj-abcdefghijklmnopqrstuvwx です。');
    const core = summarizeUsage(r, { kind: 'blocked', stage: 'B', purpose: 'summary', manualOps: 0, destination: 'copy' });
    expect(core.blockers).toEqual([]); // 既定では認証情報は削除されるので停止しない
    const blocked = summarizeUsage({ ...r, blockers: [{ kind: 'credential', message: 'x' }, { kind: 'empty', message: 'y' }] }, { kind: 'blocked', stage: 'B', purpose: 'summary', manualOps: 0, destination: 'copy' });
    expect(blocked.blockers).toEqual(['credential']);
    expect(blocked.destination).toBeNull();
  });

  test('時刻は1時間単位、出力先は対応サイトだけ', () => {
    expect(toHour(new Date('2026-10-18T03:47:12.345Z'))).toBe('2026-10-18T03:00Z');
    expect(usageDestination({ kind: 'insert', siteId: 'chatgpt' })).toBe('insert:chatgpt');
    expect(usageDestination({ kind: 'insert', siteId: 'other' })).toBeNull();
  });
});

describe('送信してよい条件（SERVER_DESIGN.md §3-1, §3-2）', () => {
  const now = '2026-10-18T00:00:00.000Z';
  const reporting = { enabled: true, endpoint: 'http://localhost:8787', orgToken: 'tc_abcdefghijklmnop1234' };

  test('組織ポリシーがなければ送らない', () => {
    expect(reportingTarget(resolvePolicy({}, now), 'http://localhost:8787')).toBeNull();
  });

  test('有効で、送信先がビルド時のオリジンと一致するときだけ送る', () => {
    expect(reportingTarget(resolvePolicy({ version: '1', reporting }, now), 'http://localhost:8787')).toMatchObject({ orgToken: reporting.orgToken });
    expect(reportingTarget(resolvePolicy({ version: '1', reporting }, now), undefined)).toBeNull();
    expect(reportingTarget(resolvePolicy({ version: '1', reporting: { ...reporting, endpoint: 'https://evil.example' } }, now), 'http://localhost:8787')).toBeNull();
    expect(reportingTarget(resolvePolicy({ version: '1', reporting: { ...reporting, enabled: false } }, now), 'http://localhost:8787')).toBeNull();
  });

  test('形の正しくない送信設定はポリシー全体をエラーにする（弱めて動かさない）', () => {
    expect(resolvePolicy({ version: '1', reporting: { ...reporting, orgToken: 'short' } }, now).status).toBe('error');
    expect(resolvePolicy({ version: '1', reporting: { ...reporting, extra: 1 } }, now).status).toBe('error');
  });
});
