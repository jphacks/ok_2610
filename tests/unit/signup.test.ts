import { beforeEach, describe, expect, test } from 'vitest';
import { createApp, createOrganization, type SignupOptions } from '../../server/src/app';
import type { Db } from '../../server/src/db';
import { emptyDb } from './db-helpers';

// 新しく始める（SERVER_DESIGN.md §15）。ログイン画面から組織と owner を作る。組織どうしのデータは見えない

let now = new Date('2026-11-12T00:00:00Z');
let db: Db;
const ON: SignupOptions = { enabled: true, maxOrganizations: 100, perHour: 10 };
const PASSWORD = 'correct horse battery staple';

const json = (body: unknown, method = 'POST', cookie?: string): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const appWith = (signup?: SignupOptions) => createApp({ db, now: () => now, publicOrigin: 'http://localhost:8787', ...(signup ? { signup } : {}) });

async function signup(app: ReturnType<typeof createApp>, organization: string, email: string, password = PASSWORD) {
  const res = await app.request('/admin/signup', json({ organization, email, password }));
  return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

beforeEach(async () => {
  now = new Date('2026-11-12T00:00:00Z');
  db = await emptyDb();
});

test('既定では作れない（画面にも出さない）', async () => {
  const app = appWith();
  expect(await (await app.request('/admin/signup')).json()).toEqual({ enabled: false });
  expect((await signup(app, '組織', 'a@example.com')).res.status).toBe(404);
});

test('作ると、その組織の owner としてログインした状態になり、変更履歴に残る', async () => {
  const app = appWith(ON);
  expect(await (await app.request('/admin/signup')).json()).toEqual({ enabled: true });
  const { res, cookie } = await signup(app, 'テスト株式会社', 'Owner@Example.com');
  expect(res.status).toBe(201);
  expect(cookie).toMatch(/^tc_admin=/);
  const me = await (await app.request('/admin/me', { headers: { cookie } })).json();
  expect(me).toEqual({ email: 'owner@example.com', organization: 'テスト株式会社', role: 'owner', department: null });
  const audit = (await (await app.request('/admin/audit', { headers: { cookie } })).json()) as { action: string }[];
  expect(audit.map((a) => a.action)).toEqual(['organization.signup']);
  // 作ったアカウントでログインもできる
  expect((await app.request('/admin/session', json({ email: 'owner@example.com', password: PASSWORD }))).status).toBe(200);
});

test('ほかの組織のデータ（トークン・ポリシー・配布・管理者・適用状況）は見えず、変えられない', async () => {
  const app = appWith(ON);
  await createOrganization(db, '最初の組織', 'first@example.com', PASSWORD, now);
  const first = (await app.request('/admin/session', json({ email: 'first@example.com', password: PASSWORD }))).headers.get('set-cookie')!.split(';')[0]!;
  const as = (cookie: string) => (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
  const a = as(first);
  const token = (await (await a('/admin/tokens', json({ label: '営業', department: 'sales' }, 'POST', first))).json()) as { token: string };
  const policy = (await (await a('/admin/policies', json({ policy: { version: 'v1' } }, 'POST', first))).json()) as { id: number };
  await a('/admin/assignments', json({ department: null, policyId: policy.id }, 'PUT', first));
  await app.request('/v1/status', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token.token}` }, body: JSON.stringify({
    schemaVersion: 1, installId: crypto.randomUUID(), reportedDay: '2026-11-12', extensionVersion: '0.11.0', policyVersion: 'v1', policyState: 'active', policySource: 'server', department: null,
  }) });

  const { cookie } = await signup(app, '後から来た組織', 'second@example.com');
  const b = as(cookie);
  expect(await (await b('/admin/tokens')).json()).toEqual([]);
  expect(await (await b('/admin/policies')).json()).toEqual([]);
  expect(await (await b('/admin/assignments')).json()).toEqual([]);
  expect(((await (await b('/admin/admins')).json()) as { email: string }[]).map((x) => x.email)).toEqual(['second@example.com']);
  expect(((await (await b('/admin/coverage')).json()) as { totals: { devices: number } }).totals.devices).toBe(0);
  expect((await b(`/admin/policies/${policy.id}`)).status).toBe(404);
  const firstTokenId = ((await (await a('/admin/tokens')).json()) as { id: number }[])[0]!.id;
  expect((await b(`/admin/tokens/${firstTokenId}`, { method: 'DELETE' })).status).toBe(404);
  // 最初の組織のトークンは、後から来た組織の操作では失効していない
  expect((await app.request('/v1/policy', { headers: { authorization: `Bearer ${token.token}` } })).status).toBe(200);
});

test('使われているメールアドレス・短いパスワード・組織名なしは作れない', async () => {
  const app = appWith(ON);
  expect((await signup(app, '組織A', 'same@example.com')).res.status).toBe(201);
  const dup = await signup(app, '組織B', 'SAME@example.com');
  expect(dup.res.status).toBe(409);
  expect(dup.cookie).toBe('');
  expect((await signup(app, '組織C', 'c@example.com', 'short')).res.status).toBe(400);
  expect((await signup(app, ' ', 'd@example.com')).res.status).toBe(400);
  expect((await db.query('SELECT name FROM organizations ORDER BY id')).map((r) => r.name)).toEqual(['組織A']);
});

test('1時間に作れる数と、組織の数の上限を超えると断る', async () => {
  const app = appWith({ enabled: true, maxOrganizations: 3, perHour: 2 });
  expect((await signup(app, '1', 'one@example.com')).res.status).toBe(201);
  expect((await signup(app, '2', 'two@example.com')).res.status).toBe(201);
  expect((await signup(app, '3', 'three@example.com')).res.status).toBe(429);
  now = new Date('2026-11-12T01:00:01Z');
  expect((await signup(app, '3', 'three@example.com')).res.status).toBe(201);
  now = new Date('2026-11-12T03:00:00Z');
  expect((await signup(app, '4', 'four@example.com')).res.status).toBe(403);
});

describe('組織を消す（§15-1）', () => {
  const TABLES = ['admins', 'org_tokens', 'policies', 'policy_assignments', 'departments', 'device_status', 'usage_events', 'audit_log'];
  const usage = (department: string | null) => ({
    schemaVersion: 1, eventId: crypto.randomUUID(), kind: 'output', occurredHour: '2026-11-12T00:00Z', extensionVersion: '0.11.0', policyVersion: 'v1',
    department, stage: 'B', purpose: 'summary', destination: 'insert:chatgpt', masked: { personName: 1 }, kept: {}, manualOps: 0, riskLevel: '要注意', blockers: [], engines: { ner: 'ok', nano: 'skipped' },
  });

  /** 組織を作り、トークン・ポリシー・配布・部署・記録・適用状況まで入れる */
  async function populated(app: ReturnType<typeof createApp>, name: string, email: string) {
    const { cookie } = await signup(app, name, email);
    const call = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
    const token = ((await (await call('/admin/tokens', json({ label: 'x', department: null }))).json()) as { token: string }).token;
    const policy = ((await (await call('/admin/policies', json({ policy: { version: 'v1' } }))).json()) as { id: number }).id;
    expect((await call('/admin/assignments', json({ department: null, policyId: policy }, 'PUT'))).status).toBe(204);
    expect((await call('/admin/setup/departments', json({ mode: 'split', departments: [{ name: '営業部', preset: 'standard' }] }, 'PUT'))).status).toBe(200);
    const bearer = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    expect((await app.request('/v1/events', { method: 'POST', headers: bearer, body: JSON.stringify({ events: [usage(null)] }) })).status).toBe(202);
    expect((await app.request('/v1/status', { method: 'POST', headers: bearer, body: JSON.stringify({
      schemaVersion: 1, installId: crypto.randomUUID(), reportedDay: '2026-11-12', extensionVersion: '0.11.0', policyVersion: 'v1', policyState: 'active', policySource: 'server', department: null,
    }) })).status).toBe(202);
    const orgId = Number((await db.one<{ org_id: number }>('SELECT org_id FROM admins WHERE email = $1', [email]))!.org_id);
    return { cookie, call, token, orgId };
  }
  const rowsOf = async (orgId: number) => {
    const counts: Record<string, number> = {};
    for (const t of TABLES) counts[t] = Number((await db.one<{ n: string }>(`SELECT COUNT(*) AS n FROM ${t} WHERE org_id = $1`, [orgId]))!.n);
    return counts;
  };

  test('owner が組織名とパスワードを入れ直すと、その組織のデータをすべて消す。ほかの組織は残る', async () => {
    const app = appWith(ON);
    const keep = await populated(app, '残す組織', 'keep@example.com');
    const gone = await populated(app, '消す組織', 'gone@example.com');
    expect(Object.values(await rowsOf(gone.orgId)).every((n) => n > 0)).toBe(true);

    const res = await gone.call('/admin/organization', json({ organizationName: '消す組織', password: PASSWORD }, 'DELETE'));
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/tc_admin=;/);
    expect(Object.values(await rowsOf(gone.orgId)).every((n) => n === 0)).toBe(true);
    expect(await db.query('SELECT 1 FROM organizations WHERE id = $1', [gone.orgId])).toEqual([]);
    expect(await db.query('SELECT 1 FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE a.org_id = $1', [gone.orgId])).toEqual([]);
    expect(await db.query('SELECT 1 FROM usage_event_categories c WHERE NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.event_id = c.event_id)')).toEqual([]);
    // セッションは切れ、トークンは使えなくなる
    expect((await gone.call('/admin/me')).status).toBe(401);
    expect((await app.request('/v1/policy', { headers: { authorization: `Bearer ${gone.token}` } })).status).toBe(401);
    // ほかの組織はそのまま
    expect(Object.values(await rowsOf(keep.orgId)).every((n) => n > 0)).toBe(true);
    expect((await keep.call('/admin/me')).status).toBe(200);
    expect((await app.request('/v1/policy', { headers: { authorization: `Bearer ${keep.token}` } })).status).toBe(200);
    // 同じメールアドレスで、また始められる
    expect((await signup(app, '新しい組織', 'gone@example.com')).res.status).toBe(201);
  });

  test('組織名・パスワードが違う、owner でないときは消さない', async () => {
    const app = appWith(ON);
    const org = await populated(app, '消さない組織', 'owner2@example.com');
    expect((await org.call('/admin/organization', json({ organizationName: '別の名前', password: PASSWORD }, 'DELETE'))).status).toBe(400);
    expect((await org.call('/admin/organization', json({ organizationName: '消さない組織', password: 'wrong password!' }, 'DELETE'))).status).toBe(403);
    expect((await org.call('/admin/organization', { method: 'DELETE' })).status).toBe(400);
    await org.call('/admin/admins', json({ email: 'viewer2@example.com', password: PASSWORD, role: 'policy_admin' }));
    const other = (await app.request('/admin/session', json({ email: 'viewer2@example.com', password: PASSWORD }))).headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/admin/organization', { ...json({ organizationName: '消さない組織', password: PASSWORD }, 'DELETE'), headers: { 'content-type': 'application/json', cookie: other } })).status).toBe(403);
    expect(Object.values(await rowsOf(org.orgId)).every((n) => n > 0)).toBe(true);
  });
});
