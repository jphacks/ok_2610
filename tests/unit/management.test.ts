import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { base64UrlDecode, base64UrlEncode, type DeviceStatus, type ManagementBootstrap, type PolicyPayload } from '../../shared/management';
import { createApp, createOrganization } from '../../server/src/app';
import { deleteExpiredEvents, MIGRATIONS, openDb, type Db } from '../../server/src/db';
import { managedMode, resolvePolicyInput, serverPolicyInput, type ServerPolicyCheck } from '../../src/core/policy';
import { sha256Hex, verifySignedPolicy } from '../../src/infra/policy-signature';

// 一元管理（SERVER_DESIGN.md §12）。サーバーの配布・適用状況・役割と、拡張側の署名の確認を通しで確かめる。

let now = new Date('2026-11-11T05:00:00Z');
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = 'http://localhost:8787';

let db: Db;
let app: ReturnType<typeof createApp>;
let cookie: string;

const json = (body: unknown, extra: Record<string, string> = {}, method = 'POST') => ({ method, headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
const as = (c: string) => (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: c } });
const admin = (path: string, init: RequestInit = {}) => as(cookie)(path, init);

async function login(email: string, password: string): Promise<string> {
  const res = await app.request('/admin/session', json({ email, password }));
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

type Issued = { token: string; bootstrap: { management: ManagementBootstrap }; bootstrapGoogle: { management: { Value: ManagementBootstrap } } };
async function issueToken(department: string | null): Promise<Issued> {
  const res = await admin('/admin/tokens', json({ label: `配布 ${department ?? '全社'}`, department }));
  expect(res.status).toBe(201);
  return (await res.json()) as Issued;
}

async function savePolicy(policy: Record<string, unknown>): Promise<number> {
  const res = await admin('/admin/policies', json({ policy }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const assign = (department: string | null, policyId: number, minExtensionVersion: string | null = null) =>
  admin('/admin/assignments', json({ department, policyId, minExtensionVersion }, {}, 'PUT'));

const fetchPolicy = (token: string, etag?: string) =>
  app.request('/v1/policy', { headers: { authorization: `Bearer ${token}`, origin: EXT, ...(etag ? { 'if-none-match': etag } : {}) } });

function status(overrides: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    schemaVersion: 1,
    installId: crypto.randomUUID(),
    reportedDay: '2026-11-11',
    extensionVersion: '0.10.0',
    policyVersion: '2026-11',
    policyState: 'active',
    policySource: 'server',
    department: null,
    ...overrides,
  };
}
const sendStatus = (token: string, body: unknown) => app.request('/v1/status', json(body, { authorization: `Bearer ${token}`, origin: EXT }));

/** 拡張がやるのと同じ手順で、受け取った署名付きポリシーを使ってよいか決める */
async function decide(signed: unknown, bootstrap: ManagementBootstrap, overrides: Partial<ServerPolicyCheck> = {}) {
  const payload = await verifySignedPolicy(signed, bootstrap.policyPublicKey);
  return resolvePolicyInput(
    serverPolicyInput({
      bootstrap,
      buildOrigin: ORIGIN,
      payload,
      tampered: signed !== null && payload === null,
      tokenHash: await sha256Hex(bootstrap.enrollmentToken),
      extensionVersion: '0.10.0',
      nowIso: now.toISOString(),
      ...overrides,
    }),
    now.toISOString(),
  );
}

beforeEach(async () => {
  now = new Date('2026-11-11T05:00:00Z');
  db = openDb(':memory:');
  app = createApp({ db, now: () => now, publicOrigin: ORIGIN });
  await createOrganization(db, 'デモ組織', 'owner@example.com', 'correct horse battery staple', now);
  cookie = await login('owner@example.com', 'correct horse battery staple');
});

describe('ポリシーの配布 /v1/policy', () => {
  test('部署に配った版を署名付きで返し、拡張は初期設定の公開鍵で確かめて使う', async () => {
    const sales = await issueToken('sales');
    expect(sales.bootstrap.management).toMatchObject({ endpoint: ORIGIN, enrollmentToken: sales.token });
    expect(sales.bootstrapGoogle.management.Value).toEqual(sales.bootstrap.management);
    const id = await savePolicy({ version: '2026-11', name: '営業部', minStage: 'B', reporting: { enabled: true } });
    expect((await assign('sales', id)).status).toBe(204);

    const res = await fetchPolicy(sales.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXT);
    const signed = await res.json();
    const policy = await decide(signed, sales.bootstrap.management);
    expect(policy).toMatchObject({
      status: 'active',
      source: 'server',
      version: '2026-11',
      minStage: 'B',
      // 利用記録の送信先とトークンは初期設定から、部署は登録トークンから決まる
      reporting: { endpoint: ORIGIN, orgToken: sales.token, department: 'sales' },
    });
  });

  test('部署の割り当てがなければ全社の既定を返し、どちらもなければ 404', async () => {
    const hr = await issueToken('hr');
    expect((await fetchPolicy(hr.token)).status).toBe(404);
    const id = await savePolicy({ version: 'default' });
    await assign(null, id);
    const payload = (await verifySignedPolicy(await (await fetchPolicy(hr.token)).json(), hr.bootstrap.management.policyPublicKey))!;
    expect(payload).toMatchObject({ version: 'default', department: 'hr' });
  });

  test('同じ日の同じ中身は ETag で 304 を返す。配り直すと新しい時刻で署名する', async () => {
    const t = await issueToken('sales');
    await assign('sales', await savePolicy({ version: 'v1' }));
    const first = await fetchPolicy(t.token);
    const etag = first.headers.get('etag')!;
    const a = (await verifySignedPolicy(await first.json(), t.bootstrap.management.policyPublicKey))!;
    expect((await fetchPolicy(t.token, etag)).status).toBe(304);

    now = new Date('2026-11-11T06:00:00Z');
    await assign('sales', await savePolicy({ version: 'v2' }));
    const second = await fetchPolicy(t.token, etag);
    expect(second.status).toBe(200);
    const b = (await verifySignedPolicy(await second.json(), t.bootstrap.management.policyPublicKey))!;
    expect(b.version).toBe('v2');
    expect(b.issuedAt > a.issuedAt).toBe(true);
  });

  test('書き換えた署名・ほかの登録先に宛てた署名・期限切れ・古い拡張は使わずに止める', async () => {
    const sales = await issueToken('sales');
    const hr = await issueToken('hr');
    await assign(null, await savePolicy({ version: 'v1' }));
    const signed = (await (await fetchPolicy(sales.token)).json()) as { payload: string; signature: string };

    // 中身を書き換えると署名が合わない
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(signed.payload))) as PolicyPayload;
    const forged = { ...signed, payload: base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...payload, policy: { version: 'v1', minStage: 'A' }, expiresAt: '2099-01-01T00:00:00.000Z' }))) };
    expect(await verifySignedPolicy(forged, sales.bootstrap.management.policyPublicKey)).toBeNull();
    expect(await decide(forged, sales.bootstrap.management)).toMatchObject({ status: 'error', state: 'invalid' });

    // 本物の署名でも、別の登録トークン（部署）の端末には使わせない
    expect(await decide(signed, hr.bootstrap.management)).toMatchObject({ status: 'error', state: 'invalid' });

    // 最長8日で期限が切れる
    now = new Date('2026-11-19T00:00:01Z');
    expect(await decide(signed, sales.bootstrap.management)).toMatchObject({ status: 'error', state: 'expired' });
  });

  test('拡張の最低版より古い拡張では止める。まだ受け取っていなければ未取得として止める', async () => {
    const t = await issueToken(null);
    await assign(null, await savePolicy({ version: 'v1' }), '0.11.0');
    const signed = await (await fetchPolicy(t.token)).json();
    expect(await decide(signed, t.bootstrap.management)).toMatchObject({ status: 'error', state: 'outdated' });
    expect(await decide(signed, t.bootstrap.management, { extensionVersion: '0.11.0' })).toMatchObject({ status: 'active' });
    expect(await decide(null, t.bootstrap.management)).toMatchObject({ status: 'error', state: 'missing' });
    expect(await decide(signed, t.bootstrap.management, { buildOrigin: 'https://other.example.com' })).toMatchObject({ status: 'error', state: 'invalid' });
  });

  test('失効したトークン・トークンなしでは受け取れない', async () => {
    const t = await issueToken('sales');
    await assign(null, await savePolicy({ version: 'v1' }));
    expect((await app.request('/v1/policy')).status).toBe(401);
    const { id } = ((await (await admin('/admin/tokens')).json()) as { id: number }[])[0]!;
    await admin(`/admin/tokens/${id}`, { method: 'DELETE' });
    expect((await fetchPolicy(t.token)).status).toBe(401);
  });

  test('配布できるのは保存済みで期限内の版だけ', async () => {
    expect((await assign(null, 999)).status).toBe(404);
    const id = await savePolicy({ version: 'soon', expiresAt: '2026-11-11T10:00:00.000Z' });
    now = new Date('2026-11-11T11:00:00Z');
    expect((await assign(null, id)).status).toBe(400);
  });
});

describe('managed storage の読み方', () => {
  const bootstrap = { endpoint: ORIGIN, enrollmentToken: 'tc_abcdefghijklmnop1234', policyPublicKey: 'MCowBQYDK2VwAyEAabcdefghijklmnopqrstuvwxyz0123456789ABCD' };
  test('初期設定だけならサーバー、ポリシー本体があれば MDM、なければ個人利用', () => {
    expect(managedMode({})).toEqual({ kind: 'none' });
    expect(managedMode({ management: bootstrap })).toEqual({ kind: 'server', bootstrap });
    expect(managedMode({ management: { ...bootstrap, extra: 1 } })).toEqual({ kind: 'invalid' });
    expect(managedMode({ version: '1', management: bootstrap })).toMatchObject({ kind: 'mdm' });
  });

  test('MDM のポリシーは、送信先とトークンがそろっているときだけ利用記録を送る', () => {
    const at = now.toISOString();
    const r = resolvePolicyInput({ kind: 'policy', source: 'mdm', raw: { version: '1', reporting: { enabled: true } } }, at);
    expect(r).toMatchObject({ status: 'active', source: 'mdm' });
    expect(r.status === 'active' && r.reporting).toBeFalsy();
    const full = resolvePolicyInput({ kind: 'policy', source: 'mdm', raw: { version: '1', reporting: { enabled: true, endpoint: ORIGIN, orgToken: bootstrap.enrollmentToken } } }, at);
    expect(full).toMatchObject({ reporting: { endpoint: ORIGIN, orgToken: bootstrap.enrollmentToken } });
  });
});

describe('適用状況 /v1/status', () => {
  test('部署は登録トークンのものを使い、端末ごとに最新の1件だけを残す。未知の項目は拒否する', async () => {
    const t = await issueToken('sales');
    const s = status({ department: 'spoofed' });
    expect((await sendStatus(t.token, s)).status).toBe(202);
    expect((await sendStatus(t.token, { ...s, policyVersion: '2026-12' })).status).toBe(202);
    expect((await sendStatus(t.token, { ...s, hostname: 'PC-001' })).status).toBe(400);
    expect((await sendStatus('tc_wrongwrongwrongwrong', s)).status).toBe(401);
    expect(db.prepare('SELECT department, policy_version FROM device_status').all()).toEqual([{ department: 'sales', policy_version: '2026-12' }]);
  });

  test('配った版を適用している台数と、止まっている台数を部署ごとに数える', async () => {
    const sales = await issueToken('sales');
    const hr = await issueToken('hr');
    await assign('sales', await savePolicy({ version: '2026-11' }));
    await assign(null, await savePolicy({ version: 'base' }));
    await sendStatus(sales.token, status());
    await sendStatus(sales.token, status({ policyVersion: '2026-10' }));
    await sendStatus(sales.token, status({ policyVersion: null, policyState: 'expired' }));
    await sendStatus(hr.token, status({ policyVersion: 'base', extensionVersion: '0.9.0' }));
    await sendStatus(hr.token, status({ reportedDay: '2026-11-01' })); // 7日より前の報告は数えない

    const c = (await (await admin('/admin/coverage')).json()) as { totals: unknown; departments: { department: string; assignedVersion: string; devices: number; current: number; states: Record<string, number> }[]; extensionVersions: unknown };
    expect(c.totals).toEqual({ devices: 4, current: 2, stopped: 1 });
    expect(c.departments.find((d) => d.department === 'sales')).toMatchObject({ assignedVersion: '2026-11', devices: 3, current: 1, states: { active: 2, expired: 1 } });
    expect(c.departments.find((d) => d.department === 'hr')).toMatchObject({ assignedVersion: 'base', devices: 1, current: 1 });
    expect(c.extensionVersions).toEqual([{ version: '0.10.0', count: 3 }, { version: '0.9.0', count: 1 }]);
  });

  test('90日報告のない端末の適用状況は消す', async () => {
    const t = await issueToken(null);
    await sendStatus(t.token, status({ reportedDay: '2026-08-01' }));
    await sendStatus(t.token, status());
    expect(deleteExpiredEvents(db, now)).toBe(1);
  });
});

describe('役割と変更履歴', () => {
  async function addAdmin(email: string, role: string, department: string | null = null) {
    const res = await admin('/admin/admins', json({ email, password: 'a long enough password', role, department }));
    expect(res.status).toBe(201);
    return login(email, 'a long enough password');
  }

  test('viewer は見るだけ、dept_viewer は担当部署の集計だけ', async () => {
    const viewer = as(await addAdmin('viewer@example.com', 'viewer'));
    expect((await viewer('/admin/assignments')).status).toBe(200);
    expect((await viewer('/admin/audit')).status).toBe(200);
    expect((await viewer('/admin/policies', json({ policy: { version: 'x' } }))).status).toBe(403);
    expect((await viewer('/admin/tokens')).status).toBe(403);
    expect((await viewer('/admin/admins')).status).toBe(403);

    const dept = as(await addAdmin('dept@example.com', 'dept_viewer', 'sales'));
    const stats = (await (await dept('/admin/stats?department=hr')).json()) as { department: string };
    expect(stats.department).toBe('sales');
    const coverage = (await (await dept('/admin/coverage')).json()) as { department: string };
    expect(coverage.department).toBe('sales');
    expect((await dept('/admin/assignments')).status).toBe(403);
    expect((await dept('/admin/audit')).status).toBe(403);
    expect(((await (await dept('/admin/me')).json()) as { role: string }).role).toBe('dept_viewer');
  });

  test('dept_viewer には担当部署が要る。owner が1人もいなくなる変更はできない', async () => {
    expect((await admin('/admin/admins', json({ email: 'd@example.com', password: 'a long enough password', role: 'dept_viewer' }))).status).toBe(400);
    expect((await admin('/admin/admins', json({ email: 'short@example.com', password: 'short', role: 'viewer' }))).status).toBe(400);
    const me = ((await (await admin('/admin/admins')).json()) as { id: number }[])[0]!;
    expect((await admin(`/admin/admins/${me.id}`, json({ role: 'viewer' }, {}, 'PATCH'))).status).toBe(409);
    expect((await admin(`/admin/admins/${me.id}`, { method: 'DELETE' })).status).toBe(409);
  });

  test('無効にした管理者はログインできず、セッションも切れる', async () => {
    const other = as(await addAdmin('policy@example.com', 'policy_admin'));
    expect((await other('/admin/me')).status).toBe(200);
    const target = ((await (await admin('/admin/admins')).json()) as { id: number; email: string }[]).find((a) => a.email === 'policy@example.com')!;
    expect((await admin(`/admin/admins/${target.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await other('/admin/me')).status).toBe(401);
    expect((await app.request('/admin/session', json({ email: 'policy@example.com', password: 'a long enough password' }))).status).toBe(401);
  });

  test('変更履歴に、誰がいつ何を変えたかを残す。トークンの平文やパスワードは残さない', async () => {
    const t = await issueToken('sales');
    const id = await savePolicy({ version: '2026-11' });
    await assign('sales', id, '0.10.0');
    await admin('/admin/admins', json({ email: 'v@example.com', password: 'a long enough password', role: 'viewer' }));
    const entries = (await (await admin('/admin/audit')).json()) as { adminEmail: string; action: string; detail: unknown }[];
    expect(entries.map((e) => e.action)).toEqual(['admin.create', 'assignment.publish', 'policy.create', 'token.create']);
    expect(entries.every((e) => e.adminEmail === 'owner@example.com')).toBe(true);
    expect(entries[1]!.detail).toEqual({ department: 'sales', version: '2026-11', minExtensionVersion: '0.10.0' });
    const raw = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
    expect(raw).not.toContain(t.token);
    expect(raw).not.toContain('a long enough password');
  });
});

describe('DB のマイグレーション', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('v0.8.0 の DB を開くと、管理者は owner になり、新しいテーブルが足される', () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-db-'));
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]!);
    old.exec("INSERT INTO organizations (name, created_at) VALUES ('旧組織', '2026-10-18')");
    old.exec("INSERT INTO admins (org_id, email, password_hash, created_at) VALUES (1, 'old@example.com', 'x', '2026-10-18')");
    old.close();
    const migrated = openDb(path);
    expect(migrated.prepare('SELECT email, role FROM admins').all()).toEqual([{ email: 'old@example.com', role: 'owner' }]);
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM policy_assignments').get()).toEqual({ n: 0 });
    migrated.close();
    // もう一度開いても流し直さない
    openDb(path).close();
  });
});
