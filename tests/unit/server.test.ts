import { beforeEach, describe, expect, test } from 'vitest';
import type { UsageEvent } from '../../shared/usage-event';
import { createApp, createOrganization } from '../../server/src/app';
import { deleteExpiredEvents, type Db } from '../../server/src/db';
import { emptyDb } from './db-helpers';

const NOW = new Date('2026-10-18T05:00:00Z');
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    kind: 'output',
    occurredHour: '2026-10-18T03:00Z',
    extensionVersion: '0.5.0',
    policyVersion: '2026-10',
    department: 'sales',
    stage: 'B',
    purpose: 'summary',
    destination: 'insert:chatgpt',
    masked: { personName: 2, phone: 1 },
    kept: { date: 2 },
    manualOps: 0,
    riskLevel: '要注意',
    blockers: [],
    engines: { ner: 'ok', nano: 'skipped' },
    ...overrides,
  };
}

let db: Db;
let app: ReturnType<typeof createApp>;
let cookie: string;
let token: string;

const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
const admin = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
const send = (events: unknown[], bearer = token) => app.request('/v1/events', json({ events }, { authorization: `Bearer ${bearer}`, origin: EXT }));


/** COUNT(*) は PostgreSQL では大きな整数になるので、数に直して比べる */
const count = async (sql: string) => Number((await db.one<{ n: unknown }>(sql))!.n);

beforeEach(async () => {
  db = await emptyDb();
  app = createApp({ db, now: () => NOW });
  await createOrganization(db, 'デモ組織', 'admin@example.com', 'correct horse battery staple', NOW);
  const login = await app.request('/admin/session', json({ email: 'admin@example.com', password: 'correct horse battery staple' }));
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const created = await admin('/admin/tokens', json({ label: 'テスト' }));
  token = ((await created.json()) as { token: string }).token;
});

describe('記録の受付 /v1/events', () => {
  test('組織トークンがなければ受け付けない', async () => {
    expect((await send([event()], 'tc_wrongwrongwrongwrong')).status).toBe(401);
    expect((await app.request('/v1/events', json({ events: [event()] }))).status).toBe(401);
  });

  test('正しい記録は 202 で受け付け、中身を返さない。同じ記録の再送は1件として数える', async () => {
    const e = event();
    const res = await send([e]);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect((await send([e])).status).toBe(202);
    expect(await count('SELECT COUNT(*) AS n FROM usage_events')).toBe(1);
  });

  test('本文などの未知の項目を含む記録は、まとめて拒否して何も保存しない', async () => {
    const res = await send([event(), { ...event(), text: '佐藤花子さんの件' }]);
    expect(res.status).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM usage_events')).toBe(0);
  });

  test('失効したトークンは使えない', async () => {
    const list = (await (await admin('/admin/tokens')).json()) as { id: number }[];
    expect((await admin(`/admin/tokens/${list[0]!.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await send([event()])).status).toBe(401);
  });

  test('CORS は拡張のオリジンだけを許す', async () => {
    const preflight = (origin: string) => app.request('/v1/events', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' } });
    expect((await preflight(EXT)).headers.get('access-control-allow-origin')).toBe(EXT);
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });

  test('一度に送れるのは50件まで', async () => {
    expect((await send(Array.from({ length: 51 }, () => event()))).status).toBe(400);
  });
});

describe('管理 API', () => {
  test('ログインしていなければ使えない。パスワードを5回間違えると一時的に止める', async () => {
    expect((await app.request('/admin/stats')).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await app.request('/admin/session', json({ email: 'admin@example.com', password: 'wrong' }))).status).toBe(401);
    expect((await app.request('/admin/session', json({ email: 'admin@example.com', password: 'correct horse battery staple' }))).status).toBe(429);
  });

  test('状態を変える API は JSON 以外を受け付けない（フォームからの CSRF を通さない）', async () => {
    const res = await admin('/admin/tokens', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'label=x' });
    expect(res.status).toBe(400);
  });

  test('集計：出力回数・送信先・種類ごとの件数・注意度・止まった理由', async () => {
    await send([
      event(),
      event({ destination: 'copy', masked: { personName: 1 }, riskLevel: '情報' }),
      event({ kind: 'blocked', destination: null, blockers: ['credential'], masked: {}, kept: {} }),
    ]);
    const stats = (await (await admin('/admin/stats?from=2026-10-18&to=2026-10-18')).json()) as Record<string, unknown>;
    expect(stats.totals).toEqual({ outputs: 2, blocked: 1 });
    expect(stats.masked).toEqual([{ category: 'personName', count: 3 }, { category: 'phone', count: 1 }]);
    expect(stats.byDestination).toEqual(expect.arrayContaining([{ destination: 'insert:chatgpt', count: 1 }, { destination: 'copy', count: 1 }]));
    expect(stats.blockers).toEqual([{ kind: 'credential', count: 1 }]);
    expect(stats.daily).toEqual([{ date: '2026-10-18', outputs: 2, blocked: 1 }]);
  });

  test('部署の記録が5件未満なら、部署別の数字を出さない', async () => {
    await send([event({ department: 'hr' }), event({ department: 'hr' }), ...Array.from({ length: 5 }, () => event({ department: 'sales' }))]);
    const all = (await (await admin('/admin/stats?from=2026-10-18&to=2026-10-18')).json()) as { departments: unknown };
    expect(all.departments).toEqual([{ department: 'sales', count: 5 }, { department: 'hr', count: null }]);
    const hr = (await (await admin('/admin/stats?from=2026-10-18&to=2026-10-18&department=hr')).json()) as { suppressed: boolean; totals: unknown; masked: unknown[] };
    expect(hr.suppressed).toBe(true);
    expect(hr.totals).toEqual({ outputs: 0, blocked: 0 });
    expect(hr.masked).toEqual([]);
  });

  test('ポリシー：拡張と同じスキーマで検証し、版ごとに保存して MDM 用に書き出す', async () => {
    const bad = await admin('/admin/policies', json({ policy: { version: '1', minStage: 'C' } }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { issues: { path: string }[] }).issues[0]!.path).toBe('minStage');

    const policy = { version: '2026-10', prohibitedCategories: ['myNumber'], reporting: { enabled: true, endpoint: 'http://localhost:8787', orgToken: token, department: 'sales' } };
    const created = await admin('/admin/policies', json({ policy }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    expect((await admin('/admin/policies', json({ policy }))).status).toBe(409);

    const google = await admin(`/admin/policies/${id}/export?format=google`);
    expect(google.headers.get('content-disposition')).toContain('text-cleaner-policy-2026-10-google.json');
    expect(await google.json()).toMatchObject({ version: { Value: '2026-10' }, prohibitedCategories: { Value: ['myNumber'] } });
    expect(await (await admin(`/admin/policies/${id}/export`)).json()).toMatchObject({ version: '2026-10' });
  });

  test('ほかの組織のポリシーやトークンには触れない', async () => {
    const created = await admin('/admin/policies', json({ policy: { version: 'a' } }));
    const { id } = (await created.json()) as { id: number };
    await createOrganization(db, '別組織', 'other@example.com', 'another long password', NOW);
    const login = await app.request('/admin/session', json({ email: 'other@example.com', password: 'another long password' }));
    const other = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request(`/admin/policies/${id}`, { headers: { cookie: other } })).status).toBe(404);
  });
});

test('保存期間（13か月）を過ぎた記録を消す', async () => {
  await send([event({ occurredHour: '2025-09-01T00:00Z' }), event()]);
  expect(await deleteExpiredEvents(db, NOW)).toBe(1);
  expect(await count('SELECT COUNT(*) AS n FROM usage_events')).toBe(1);
  expect(await count('SELECT COUNT(*) AS n FROM usage_event_categories')).toBe(3);
});
