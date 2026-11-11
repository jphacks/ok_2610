import { beforeEach, describe, expect, test } from 'vitest';
import { PRESETS, PREVIEW_TEXT, presetOf } from '../../shared/policy-presets';
import { createApp, createOrganization } from '../../server/src/app';
import type { Db } from '../../server/src/db';
import { emptyDb } from './db-helpers';
import { resolvePolicy } from '../../src/core/policy';
import { verifySignedPolicy } from '../../src/infra/policy-signature';
import { run, settings } from './helpers';

// 初回の案内（はじめての設定、SERVER_DESIGN.md §13）。ひな形からポリシーを作って配り、進み具合をデータから決める。

const NOW = new Date('2026-11-11T05:00:00Z');
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

let db: Db;
let app: ReturnType<typeof createApp>;
let cookie: string;

const json = (body: unknown, method = 'PUT') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const admin = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
type Setup = { organization: { name: string; contact: string | null }; departmentMode: string | null; departments: { code: string; name: string; preset: string }[]; steps: Record<string, boolean>; complete: boolean };
const setup = async () => (await (await admin('/admin/setup')).json()) as Setup;
const assignments = () => db.query<{ department: string; version: string; body_json: string }>("SELECT a.department, p.version, p.body_json FROM policy_assignments a JOIN policies p ON p.id = a.policy_id ORDER BY a.department");

beforeEach(async () => {
  db = await emptyDb();
  app = createApp({ db, now: () => NOW, publicOrigin: 'http://localhost:8787' });
  await createOrganization(db, 'デモ組織', 'owner@example.com', 'correct horse battery staple', NOW);
  const login = await app.request('/admin/session', json({ email: 'owner@example.com', password: 'correct horse battery staple' }, 'POST'));
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});

describe('はじめての設定', () => {
  test('進み具合は作られたデータから決まり、5つ済むと完了になる', async () => {
    expect((await setup()).steps).toEqual({ organization: false, rules: false, departments: false, distribute: false, connected: false });

    expect((await admin('/admin/setup/organization', json({ name: 'デモ株式会社', contact: '情報システム部 内線 1234' }))).status).toBe(204);
    expect((await admin('/admin/setup/rules', json({ preset: 'standard', collectUsage: true }))).status).toBe(204);
    expect((await admin('/admin/setup/departments', json({ mode: 'whole', departments: [] }))).status).toBe(200);
    const token = ((await (await admin('/admin/tokens', json({ label: 'はじめての設定（全社）', department: null }, 'POST'))).json()) as { token: string }).token;
    let s = await setup();
    expect(s.steps).toEqual({ organization: true, rules: true, departments: true, distribute: true, connected: false });
    expect(s.departmentMode).toBe('whole');

    await app.request('/v1/status', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, origin: EXT }, body: JSON.stringify({ schemaVersion: 1, installId: crypto.randomUUID(), reportedDay: '2026-11-11', extensionVersion: '0.11.0', policyVersion: 'standard-20261111', policyState: 'active', policySource: 'server', department: null }) });
    s = await setup();
    expect(s.complete).toBe(true);
    expect(((await (await admin('/admin/me')).json()) as { organization: string }).organization).toBe('デモ株式会社');
  });

  test('ひな形から、組織名と相談先の入ったポリシーを作って全社に配る。同じ内容なら版を増やさない', async () => {
    await admin('/admin/setup/organization', json({ name: 'デモ株式会社', contact: '情報システム部 内線 1234' }));
    await admin('/admin/setup/rules', json({ preset: 'strictest', collectUsage: true }));
    await admin('/admin/setup/rules', json({ preset: 'strictest', collectUsage: true }));
    const [a] = await assignments();
    expect(a!.department).toBe('');
    expect(a!.version).toBe('strictest-20261111');
    expect(JSON.parse(a!.body_json)).toEqual({
      version: 'strictest-20261111',
      name: 'デモ株式会社（個人情報を特に厳しく）',
      contact: '情報システム部 内線 1234',
      minStage: 'B',
      lockedCategories: ['personName', 'address', 'phone', 'email'],
      prohibitedCategories: ['myNumber', 'bankAccount', 'creditCard'],
      reporting: { enabled: true },
    });
    expect(Number((await db.one<{ n: unknown }>('SELECT COUNT(*) AS n FROM policies'))!.n)).toBe(1);

    // 利用記録を集めないにすると、別の版を作って配り直す
    await admin('/admin/setup/rules', json({ preset: 'strictest', collectUsage: false }));
    const [b] = await assignments();
    expect(b!.version).toBe('strictest-20261111-2');
    expect(JSON.parse(b!.body_json).reporting).toBeUndefined();
  });

  test('部署に管理用の名前を自動で付けて、部署ごとのルールを配る。拡張は署名付きで受け取れる', async () => {
    await admin('/admin/setup/organization', json({ name: 'デモ株式会社', contact: '' }));
    await admin('/admin/setup/rules', json({ preset: 'standard', collectUsage: true }));
    const saved = await admin('/admin/setup/departments', json({ mode: 'split', departments: [{ name: '営業部', preset: 'standard' }, { name: '人事部', preset: 'strictest' }] }));
    expect(((await saved.json()) as { departments: unknown }).departments).toEqual([
      { code: 'dept-01', name: '営業部', preset: 'standard' },
      { code: 'dept-02', name: '人事部', preset: 'strictest' },
    ]);
    expect((await assignments()).map((a) => [a.department, a.version])).toEqual([['', 'standard-20261111'], ['dept-01', 'standard-20261111'], ['dept-02', 'strictest-20261111']]);

    const issued = (await (await admin('/admin/tokens', json({ label: 'はじめての設定（人事部）', department: 'dept-02' }, 'POST'))).json()) as { token: string; bootstrap: { management: { policyPublicKey: string } } };
    const res = await app.request('/v1/policy', { headers: { authorization: `Bearer ${issued.token}`, origin: EXT } });
    const payload = (await verifySignedPolicy(await res.json(), issued.bootstrap.management.policyPublicKey))!;
    expect(resolvePolicy(payload.policy, NOW.toISOString())).toMatchObject({ status: 'active', name: 'デモ株式会社（個人情報を特に厳しく）', minStage: 'B', prohibited: ['myNumber', 'bankAccount', 'creditCard'] });

    // 名前を変えても管理用の名前はそのまま。外した部署は配布も外す
    await admin('/admin/setup/departments', json({ mode: 'split', departments: [{ code: 'dept-02', name: '人事総務部', preset: 'strict' }, { name: '開発部', preset: 'standard' }] }));
    expect((await setup()).departments).toEqual([
      { code: 'dept-02', name: '人事総務部', preset: 'strict' },
      { code: 'dept-03', name: '開発部', preset: 'standard' },
    ]);
    expect((await assignments()).map((a) => a.department)).toEqual(['', 'dept-02', 'dept-03']);

    // 全社で同じにすると、案内で作った部署と配布を外す
    await admin('/admin/setup/departments', json({ mode: 'whole', departments: [] }));
    expect((await setup()).departmentMode).toBe('whole');
    expect((await assignments()).map((a) => a.department)).toEqual(['']);
  });

  test('同じ部署名・知らないひな形は受け付けない。viewer は使えない', async () => {
    expect((await admin('/admin/setup/departments', json({ mode: 'split', departments: [{ name: '営業部', preset: 'standard' }, { name: '営業部', preset: 'strict' }] }))).status).toBe(400);
    expect((await admin('/admin/setup/rules', json({ preset: 'lenient', collectUsage: true }))).status).toBe(400);
    await admin('/admin/admins', json({ email: 'viewer@example.com', password: 'a long enough password', role: 'viewer' }, 'POST'));
    const login = await app.request('/admin/session', json({ email: 'viewer@example.com', password: 'a long enough password' }, 'POST'));
    const viewer = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/admin/setup', { headers: { cookie: viewer } })).status).toBe(403);
    expect((await app.request('/admin/setup/rules', { ...json({ preset: 'standard', collectUsage: true }), headers: { 'content-type': 'application/json', cookie: viewer } })).status).toBe(403);
  });
});

describe('ひな形の見え方（管理画面の見本と同じ判定）', () => {
  test.each(PRESETS.map((p) => [p.id, p] as const))('%s：氏名と電話番号は隠し、仕事の日付は残す', async (_id, preset) => {
    const r = await run(PREVIEW_TEXT, { policy: resolvePolicy({ version: 'x', ...preset.rules }, NOW.toISOString()), settings: settings({ stage: preset.rules.minStage ?? 'A' }) });
    expect(r.masked).not.toContain('佐藤花子');
    expect(r.masked).not.toContain('090-1234-5678');
    expect(r.masked).toContain('10月3日');
  });

  test('標準は生年月日を年に、厳しめは年代にぼかす', async () => {
    const at = (id: string) => run(PREVIEW_TEXT, { policy: resolvePolicy({ version: 'x', ...presetOf(id)!.rules }, NOW.toISOString()), settings: settings({ stage: presetOf(id)!.rules.minStage ?? 'A' }) });
    expect((await at('standard')).masked).toContain('1958年生まれ');
    expect((await at('strict')).masked).toContain('1950年代生まれ');
  });
});
