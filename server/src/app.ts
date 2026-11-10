import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { SAFE_TOKEN, UsageBatchSchema } from '../../shared/usage-event';
import { PolicySchema, resolvePolicy } from '../../src/core/policy';
import { transaction, type Db } from './db';
import { hashPassword, newOrgToken, newSessionId, sha256, verifyPassword } from './secrets';
import { computeStats } from './stats';

// 利用記録サーバーの API（SERVER_DESIGN.md §4）。
// /v1/events は拡張から記録を受け取るだけ。中身は返さず、受け取った記録をログにも出さない。
// /admin/* は管理画面用。管理者のセッション Cookie（HttpOnly・SameSite=Strict）で守る。

export type AppOptions = {
  db: Db;
  now?: () => Date;
  /** 記録を受け付ける拡張の ID。空なら chrome-extension:// のオリジンをすべて許す（開発用） */
  extensionIds?: string[];
  /** 本番（HTTPS）では Cookie に Secure を付ける */
  secureCookies?: boolean;
};

type Admin = { id: number; orgId: number; email: string };
type Env = { Variables: { admin: Admin } };

const SESSION_COOKIE = 'tc_admin';
const SESSION_HOURS = 12;
const EVENTS_PER_MINUTE = 600;
const LOGIN_FAILURES = 5;

const LoginSchema = z.strictObject({ email: z.string().min(3).max(254), password: z.string().min(1).max(256) });
const TokenSchema = z.strictObject({ label: z.string().trim().min(1).max(40) });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const StatsQuerySchema = z.object({ from: date.optional(), to: date.optional(), department: z.string().regex(SAFE_TOKEN).optional() });

/** 状態を変える管理 API は JSON だけを受け付ける。フォームからの CSRF を通さない */
async function readJson(c: Context): Promise<unknown> {
  if (!c.req.header('content-type')?.startsWith('application/json')) return undefined;
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createApp({ db, now = () => new Date(), extensionIds = [], secureCookies = false }: AppOptions) {
  const app = new Hono<Env>();
  const iso = () => now().toISOString();

  // ---- 拡張からの記録の受付 ----------------------------------------------------------------
  const allowedOrigin = (origin: string) =>
    extensionIds.length ? extensionIds.some((id) => origin === `chrome-extension://${id}`) : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  app.use('/v1/*', cors({ origin: (origin) => (allowedOrigin(origin) ? origin : null), allowMethods: ['POST'], allowHeaders: ['content-type', 'authorization'], maxAge: 600 }));

  const recent = new Map<number, number[]>();
  function rateLimited(tokenId: number): boolean {
    const t = now().getTime();
    const hits = (recent.get(tokenId) ?? []).filter((h) => t - h < 60_000);
    hits.push(t);
    recent.set(tokenId, hits);
    return hits.length > EVENTS_PER_MINUTE / 10; // 1回の送信は最大50件。毎分60回の送信 = 600件まで
  }

  const insertEvent = db.prepare(`INSERT OR IGNORE INTO usage_events
    (event_id, org_id, kind, occurred_hour, extension_version, policy_version, department, stage, purpose, destination, risk_level, manual_ops, ner, nano, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertCategory = db.prepare('INSERT INTO usage_event_categories (event_id, category, masked, kept) VALUES (?, ?, ?, ?)');
  const insertBlocker = db.prepare('INSERT INTO usage_event_blockers (event_id, blocker_kind) VALUES (?, ?)');

  app.post('/v1/events', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.body(null, 413) }), async (c) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer (tc_[A-Za-z0-9_-]{16,128})$/)?.[1];
    if (!bearer) return c.body(null, 401);
    const token = db.prepare('SELECT id, org_id FROM org_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(bearer)) as { id: number; org_id: number } | undefined;
    if (!token) return c.body(null, 401);
    if (rateLimited(token.id)) return c.body(null, 429);
    const parsed = UsageBatchSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.body(null, 400);
    const receivedAt = iso();
    transaction(db, () => {
      for (const e of parsed.data.events) {
        const inserted = insertEvent.run(
          e.eventId, token.org_id, e.kind, e.occurredHour, e.extensionVersion, e.policyVersion, e.department,
          e.stage, e.purpose, e.destination, e.riskLevel, e.manualOps, e.engines.ner, e.engines.nano, receivedAt,
        );
        if (!inserted.changes) continue; // 再送された同じ記録は数えない
        const categories = new Set([...Object.keys(e.masked), ...Object.keys(e.kept)]) as Set<keyof typeof e.masked>;
        for (const category of categories) insertCategory.run(e.eventId, category, e.masked[category] ?? 0, e.kept[category] ?? 0);
        for (const kind of e.blockers) insertBlocker.run(e.eventId, kind);
      }
    });
    return c.body(null, 202);
  });

  // ---- 管理者のログイン -------------------------------------------------------------------
  const failures = new Map<string, number[]>();

  app.post('/admin/session', async (c) => {
    const parsed = LoginSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.body(null, 400);
    const email = parsed.data.email.toLowerCase();
    const t = now().getTime();
    const recentFailures = (failures.get(email) ?? []).filter((f) => t - f < 15 * 60_000);
    if (recentFailures.length >= LOGIN_FAILURES) return c.body(null, 429);
    const admin = db.prepare('SELECT id, org_id, password_hash FROM admins WHERE email = ?').get(email) as { id: number; org_id: number; password_hash: string } | undefined;
    if (!admin || !(await verifyPassword(parsed.data.password, admin.password_hash))) {
      failures.set(email, [...recentFailures, t]);
      return c.body(null, 401);
    }
    failures.delete(email);
    const sessionId = newSessionId();
    const expires = new Date(t + SESSION_HOURS * 60 * 60_000);
    db.prepare('INSERT INTO admin_sessions (id_hash, admin_id, expires_at) VALUES (?, ?, ?)').run(sha256(sessionId), admin.id, expires.toISOString());
    setCookie(c, SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'Strict', secure: secureCookies, path: '/', expires });
    return c.json({ email });
  });

  const requireAdmin = createMiddleware<Env>(async (c, next) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    const row = sessionId
      ? (db.prepare(`SELECT a.id, a.org_id, a.email FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id_hash = ? AND s.expires_at > ?`).get(sha256(sessionId), iso()) as
          | { id: number; org_id: number; email: string }
          | undefined)
      : undefined;
    if (!row) return c.body(null, 401);
    c.set('admin', { id: row.id, orgId: row.org_id, email: row.email });
    await next();
  });

  app.use('/admin/*', async (c, next) => (c.req.path === '/admin/session' && c.req.method === 'POST' ? next() : requireAdmin(c, next)));

  app.delete('/admin/session', (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(sha256(sessionId));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.get('/admin/me', (c) => {
    const admin = c.get('admin');
    const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(admin.orgId) as { name: string };
    return c.json({ email: admin.email, organization: org.name });
  });

  // ---- 集計 -----------------------------------------------------------------------------
  app.get('/admin/stats', (c) => {
    const parsed = StatsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.body(null, 400);
    const today = iso().slice(0, 10);
    const monthAgo = new Date(now().getTime() - 29 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const { from = monthAgo, to = today, department } = parsed.data;
    if (from > to) return c.body(null, 400);
    return c.json(computeStats(db, c.get('admin').orgId, { from, to, ...(department ? { department } : {}) }));
  });

  // ---- 組織ポリシー（版ごとに不変。編集は新しい版を作る） ---------------------------------------
  app.get('/admin/policies', (c) => {
    const rows = db.prepare(`SELECT p.id, p.version, p.created_at, a.email FROM policies p JOIN admins a ON a.id = p.created_by WHERE p.org_id = ? ORDER BY p.id DESC`).all(c.get('admin').orgId) as Row[];
    return c.json(rows.map((r) => ({ id: r.id, version: r.version, createdAt: r.created_at, createdBy: r.email })));
  });

  app.get('/admin/policies/:id', (c) => {
    const row = policyRow(c.get('admin').orgId, c.req.param('id'));
    return row ? c.json({ id: row.id, version: row.version, createdAt: row.created_at, policy: JSON.parse(row.body_json) }) : c.body(null, 404);
  });

  app.post('/admin/policies', async (c) => {
    const body = (await readJson(c)) as { policy?: unknown } | undefined;
    const parsed = PolicySchema.strict().safeParse(body?.policy);
    if (!parsed.success) return c.json({ issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
    // 拡張と同じ解釈で読めるか（有効期限など）まで確かめてから保存する
    const resolved = resolvePolicy(parsed.data, iso());
    if (resolved.status === 'error') return c.json({ issues: [{ path: '', message: resolved.reason }] }, 400);
    const admin = c.get('admin');
    try {
      const result = db.prepare('INSERT INTO policies (org_id, version, body_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(admin.orgId, parsed.data.version, JSON.stringify(parsed.data), admin.id, iso());
      return c.json({ id: Number(result.lastInsertRowid), version: parsed.data.version }, 201);
    } catch {
      return c.json({ issues: [{ path: 'version', message: 'この版はすでにあります。新しい版の名前を付けてください。' }] }, 409);
    }
  });

  /** MDM に貼る JSON。google は Google 管理コンソールの拡張ポリシー形式（各項目を { Value } で包む） */
  app.get('/admin/policies/:id/export', (c) => {
    const row = policyRow(c.get('admin').orgId, c.req.param('id'));
    if (!row) return c.body(null, 404);
    const policy = JSON.parse(row.body_json) as Record<string, unknown>;
    const format = c.req.query('format') === 'google' ? 'google' : 'raw';
    const out = format === 'google' ? Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, { Value: v }])) : policy;
    c.header('content-disposition', `attachment; filename="text-cleaner-policy-${row.version.replace(/[^A-Za-z0-9._-]/g, '_')}-${format}.json"`);
    return c.json(out);
  });

  function policyRow(orgId: number, id: string) {
    return db.prepare('SELECT id, version, body_json, created_at FROM policies WHERE org_id = ? AND id = ?').get(orgId, Number(id)) as
      | { id: number; version: string; body_json: string; created_at: string }
      | undefined;
  }

  // ---- 組織トークン ------------------------------------------------------------------------
  app.get('/admin/tokens', (c) => {
    const rows = db.prepare('SELECT id, label, created_at, revoked_at FROM org_tokens WHERE org_id = ? ORDER BY id DESC').all(c.get('admin').orgId) as Row[];
    return c.json(rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, revokedAt: r.revoked_at })));
  });

  /** 平文のトークンは作ったときに1回だけ返す。DB にはハッシュだけを置く */
  app.post('/admin/tokens', async (c) => {
    const parsed = TokenSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.body(null, 400);
    const token = newOrgToken();
    const result = db.prepare('INSERT INTO org_tokens (org_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)').run(c.get('admin').orgId, sha256(token), parsed.data.label, iso());
    return c.json({ id: Number(result.lastInsertRowid), label: parsed.data.label, token }, 201);
  });

  app.delete('/admin/tokens/:id', (c) => {
    const result = db.prepare('UPDATE org_tokens SET revoked_at = ? WHERE org_id = ? AND id = ? AND revoked_at IS NULL').run(iso(), c.get('admin').orgId, Number(c.req.param('id')));
    return c.body(null, result.changes ? 204 : 404);
  });

  return app;
}

type Row = Record<string, string | number | null>;

/** 初回起動用。組織と最初の管理者を作る */
export async function createOrganization(db: Db, name: string, email: string, password: string, now = new Date()): Promise<number> {
  const passwordHash = await hashPassword(password);
  return transaction(db, () => {
    const org = db.prepare('INSERT INTO organizations (name, created_at) VALUES (?, ?)').run(name, now.toISOString());
    const orgId = Number(org.lastInsertRowid);
    db.prepare('INSERT INTO admins (org_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(orgId, email.toLowerCase(), passwordHash, now.toISOString());
    return orgId;
  });
}
