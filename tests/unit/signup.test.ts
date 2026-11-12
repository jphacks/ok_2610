import { beforeEach, expect, test } from 'vitest';
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
