import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { base64UrlEncode, DeviceStatusSchema, PolicyPayloadSchema, TOKEN_PATTERN, type PolicyPayload } from '../../shared/management';
import { SAFE_TOKEN, UsageBatchSchema } from '../../shared/usage-event';
import { PolicySchema, resolvePolicy } from '../../src/core/policy';
import { computeCoverage } from './coverage';
import type { Db } from './db';
import { hashPassword, newOrgToken, newSessionId, sha256, verifyPassword } from './secrets';
import { registerSetup } from './setup';
import { ephemeralSigner, type Signer } from './signing';
import { computeStats } from './stats';

// 管理サーバーの API（SERVER_DESIGN.md §4・§12）。
// /v1/* は拡張が使う。記録と適用状況を受け取り、署名付きのポリシーを返す。受け取ったものはログに出さない。
// /admin/* は管理画面用。管理者のセッション Cookie（HttpOnly・SameSite=Strict）と役割で守る。

export type AppOptions = {
  db: Db;
  now?: () => Date;
  /** 記録を受け付ける拡張の ID。空なら chrome-extension:// のオリジンをすべて許す（開発用） */
  extensionIds?: string[];
  /** 本番（HTTPS）では Cookie に Secure を付ける */
  secureCookies?: boolean;
  /** ポリシーの署名鍵。省略すると起動のたびに作る（試験用） */
  signer?: Signer;
  /** 拡張に配る初期設定の送信先。省略すると要求の URL のオリジンを使う */
  publicOrigin?: string;
};

export const ROLES = ['owner', 'policy_admin', 'viewer', 'dept_viewer'] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { dept_viewer: 0, viewer: 1, policy_admin: 2, owner: 3 };

type Admin = { id: number; orgId: number; email: string; role: Role; department: string | null };
type Env = { Variables: { admin: Admin } };
export type AppEnv = Env;
type Token = { id: number; org_id: number; department: string | null; token_hash: string };

const SESSION_COOKIE = 'tc_admin';
const SESSION_HOURS = 12;
const REQUESTS_PER_MINUTE = 60;
const LOGIN_FAILURES = 5;
const DAY_MS = 24 * 60 * 60_000;
/** 署名したポリシーを、通信できない端末が使い続けてよい日数（その日の始まりから数える） */
export const POLICY_CACHE_DAYS = 8;

const department = z.string().regex(SAFE_TOKEN);
const LoginSchema = z.strictObject({ email: z.string().min(3).max(254), password: z.string().min(1).max(256) });
const TokenSchema = z.strictObject({ label: z.string().trim().min(1).max(40), department: department.nullable().optional() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const StatsQuerySchema = z.object({ from: date.optional(), to: date.optional(), department: department.optional() });
const CoverageQuerySchema = z.object({ department: department.optional() });
const AssignmentSchema = z.strictObject({
  department: department.nullable(),
  policyId: z.number().int().positive(),
  minExtensionVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable().optional(),
});
const roleFields = {
  role: z.enum(ROLES),
  department: department.nullable().optional(),
};
const needsDepartment = (v: { role: Role; department?: string | null | undefined }) => v.role !== 'dept_viewer' || !!v.department;
const AdminCreateSchema = z
  .strictObject({ email: z.email().max(254), password: z.string().min(12).max(256), ...roleFields })
  .refine(needsDepartment, { path: ['department'], message: '担当部署を指定してください' });
const AdminUpdateSchema = z.strictObject(roleFields).refine(needsDepartment, { path: ['department'], message: '担当部署を指定してください' });

/** 状態を変える管理 API は JSON だけを受け付ける。フォームからの CSRF を通さない */
async function readJson(c: Context): Promise<unknown> {
  if (!c.req.header('content-type')?.startsWith('application/json')) return undefined;
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const issues = (error: z.ZodError) => error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/** URL の数字の ID。数字でなければ null（DB に渡す前に弾く） */
function idOf(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

const INSERT_EVENT = `INSERT INTO usage_events
  (event_id, org_id, kind, occurred_hour, extension_version, policy_version, department, stage, purpose, destination, risk_level, manual_ops, ner, nano, received_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (event_id) DO NOTHING`;

export function createApp({ db, now = () => new Date(), extensionIds = [], secureCookies = false, signer = ephemeralSigner(), publicOrigin }: AppOptions) {
  const app = new Hono<Env>();
  const iso = () => now().toISOString();

  /** 変更履歴に残す。q を渡すと、その変更と同じトランザクションで書く */
  async function audit(admin: Admin, action: string, detail: Record<string, unknown>, q: Db = db) {
    await q.run('INSERT INTO audit_log (org_id, admin_id, admin_email, action, detail_json, at) VALUES ($1, $2, $3, $4, $5, $6)',
      [admin.orgId, admin.id, admin.email, action, JSON.stringify(detail), iso()]);
  }

  // ---- 拡張が使う API --------------------------------------------------------------------
  const allowedOrigin = (origin: string) =>
    extensionIds.length ? extensionIds.some((id) => origin === `chrome-extension://${id}`) : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  app.use('/v1/*', cors({
    origin: (origin) => (allowedOrigin(origin) ? origin : null),
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['content-type', 'authorization', 'if-none-match'],
    exposeHeaders: ['etag'],
    maxAge: 600,
  }));

  const recent = new Map<string, number[]>();
  /** トークンごと・用途ごとに毎分60回まで。利用記録は1回最大50件なので毎分3000件まで */
  function rateLimited(tokenId: number, bucket: string): boolean {
    const key = `${tokenId}:${bucket}`;
    const t = now().getTime();
    const hits = (recent.get(key) ?? []).filter((h) => t - h < 60_000);
    hits.push(t);
    recent.set(key, hits);
    return hits.length > REQUESTS_PER_MINUTE;
  }

  async function tokenOf(c: Context): Promise<Token | undefined> {
    const bearer = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!bearer || !TOKEN_PATTERN.test(bearer)) return undefined;
    return db.one<Token>('SELECT id, org_id, department, token_hash FROM org_tokens WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(bearer)]);
  }

  app.post('/v1/events', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.body(null, 413) }), async (c) => {
    const token = await tokenOf(c);
    if (!token) return c.body(null, 401);
    if (rateLimited(token.id, 'events')) return c.body(null, 429);
    const parsed = UsageBatchSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.body(null, 400);
    const receivedAt = iso();
    await db.tx(async (t) => {
      for (const e of parsed.data.events) {
        const inserted = await t.run(INSERT_EVENT, [
          e.eventId, token.org_id, e.kind, e.occurredHour, e.extensionVersion, e.policyVersion, e.department,
          e.stage, e.purpose, e.destination, e.riskLevel, e.manualOps, e.engines.ner, e.engines.nano, receivedAt,
        ]);
        if (!inserted) continue; // 再送された同じ記録は数えない
        const categories = new Set([...Object.keys(e.masked), ...Object.keys(e.kept)]) as Set<keyof typeof e.masked>;
        for (const category of categories) {
          await t.run('INSERT INTO usage_event_categories (event_id, category, masked, kept) VALUES ($1, $2, $3, $4)', [e.eventId, category, e.masked[category] ?? 0, e.kept[category] ?? 0]);
        }
        for (const kind of e.blockers) await t.run('INSERT INTO usage_event_blockers (event_id, blocker_kind) VALUES ($1, $2)', [e.eventId, kind]);
      }
    });
    return c.body(null, 202);
  });

  /** 登録トークンの部署に配っている署名付きポリシー。部署の割り当てがなければ全社の既定を返す */
  async function policyPayload(token: Token): Promise<PolicyPayload | null> {
    const row = await db.one(`SELECT a.policy_id, a.min_extension_version, a.published_at, p.version, p.body_json
      FROM policy_assignments a JOIN policies p ON p.id = a.policy_id
      WHERE a.org_id = $1 AND a.department IN ($2, '') ORDER BY a.department = '' LIMIT 1`, [token.org_id, token.department ?? '']);
    if (!row) return null;
    // 同じ日のうちは同じ中身になるよう、署名の時刻を日の始まりに丸める（ETag で「変わっていない」を返せる）。
    // その日に配り直したときは公開した時刻にし、同じ日の古い署名へ戻されないようにする
    const dayStart = new Date(`${iso().slice(0, 10)}T00:00:00.000Z`);
    const published = String(row.published_at);
    const issuedAt = published > dayStart.toISOString() ? published : dayStart.toISOString();
    return PolicyPayloadSchema.parse({
      schemaVersion: 1,
      orgId: Number(token.org_id),
      department: token.department,
      tokenHash: token.token_hash,
      policyId: Number(row.policy_id),
      version: String(row.version),
      issuedAt,
      expiresAt: new Date(dayStart.getTime() + POLICY_CACHE_DAYS * DAY_MS).toISOString(),
      minExtensionVersion: row.min_extension_version === null ? null : String(row.min_extension_version),
      policy: JSON.parse(String(row.body_json)) as Record<string, unknown>,
    });
  }

  app.get('/v1/policy', async (c) => {
    const token = await tokenOf(c);
    if (!token) return c.body(null, 401);
    if (rateLimited(token.id, 'policy')) return c.body(null, 429);
    const payload = await policyPayload(token);
    if (!payload) return c.body(null, 404);
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const etag = `"${sha256(Buffer.from(bytes).toString('base64'))}"`;
    c.header('etag', etag);
    c.header('cache-control', 'no-store');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json({ payload: base64UrlEncode(bytes), signature: base64UrlEncode(signer.sign(bytes)) });
  });

  app.post('/v1/status', bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.body(null, 413) }), async (c) => {
    const token = await tokenOf(c);
    if (!token) return c.body(null, 401);
    if (rateLimited(token.id, 'status')) return c.body(null, 429);
    const parsed = DeviceStatusSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.body(null, 400);
    const s = parsed.data;
    // 部署は登録トークンのものを優先する（端末の申告より、管理者が発行したトークンを信じる）
    await db.run(`INSERT INTO device_status (org_id, install_id, reported_day, extension_version, policy_version, policy_state, policy_source, department, received_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (org_id, install_id) DO UPDATE SET reported_day = excluded.reported_day, extension_version = excluded.extension_version,
        policy_version = excluded.policy_version, policy_state = excluded.policy_state, policy_source = excluded.policy_source,
        department = excluded.department, received_at = excluded.received_at`,
      [token.org_id, s.installId, s.reportedDay, s.extensionVersion, s.policyVersion, s.policyState, s.policySource, token.department ?? s.department, iso()]);
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
    const admin = await db.one<{ id: number; password_hash: string }>('SELECT id, password_hash FROM admins WHERE email = $1 AND disabled_at IS NULL', [email]);
    if (!admin || !(await verifyPassword(parsed.data.password, admin.password_hash))) {
      failures.set(email, [...recentFailures, t]);
      return c.body(null, 401);
    }
    failures.delete(email);
    const sessionId = newSessionId();
    const expires = new Date(t + SESSION_HOURS * 60 * 60_000);
    await db.run('INSERT INTO admin_sessions (id_hash, admin_id, expires_at) VALUES ($1, $2, $3)', [sha256(sessionId), admin.id, expires.toISOString()]);
    setCookie(c, SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'Strict', secure: secureCookies, path: '/', expires });
    return c.json({ email });
  });

  const requireAdmin = createMiddleware<Env>(async (c, next) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    const row = sessionId
      ? await db.one<{ id: number; org_id: number; email: string; role: Role; department: string | null }>(
          `SELECT a.id, a.org_id, a.email, a.role, a.department FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
           WHERE s.id_hash = $1 AND s.expires_at > $2 AND a.disabled_at IS NULL`, [sha256(sessionId), iso()])
      : undefined;
    if (!row) return c.body(null, 401);
    c.set('admin', { id: Number(row.id), orgId: Number(row.org_id), email: row.email, role: row.role, department: row.department });
    await next();
  });

  app.use('/admin/*', async (c, next) => (c.req.path === '/admin/session' && c.req.method === 'POST' ? next() : requireAdmin(c, next)));

  /** この役割以上でないと使えない */
  const atLeast = (min: Role) => createMiddleware<Env>(async (c, next) => (RANK[c.get('admin').role] >= RANK[min] ? next() : c.body(null, 403)));

  /** 集計の部署。担当部署だけを見る役割は、指定に関わらず担当部署に絞る */
  function scopedDepartment(admin: Admin, requested: string | undefined): string | undefined | false {
    if (admin.role !== 'dept_viewer') return requested;
    return admin.department ?? false;
  }

  app.delete('/admin/session', async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) await db.run('DELETE FROM admin_sessions WHERE id_hash = $1', [sha256(sessionId)]);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.get('/admin/me', async (c) => {
    const admin = c.get('admin');
    const org = (await db.one<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [admin.orgId]))!;
    return c.json({ email: admin.email, organization: org.name, role: admin.role, department: admin.department });
  });

  // ---- 集計 -----------------------------------------------------------------------------
  app.get('/admin/stats', async (c) => {
    const parsed = StatsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.body(null, 400);
    const today = iso().slice(0, 10);
    const monthAgo = new Date(now().getTime() - 29 * DAY_MS).toISOString().slice(0, 10);
    const { from = monthAgo, to = today } = parsed.data;
    if (from > to) return c.body(null, 400);
    const dept = scopedDepartment(c.get('admin'), parsed.data.department);
    if (dept === false) return c.body(null, 403);
    return c.json(await computeStats(db, c.get('admin').orgId, { from, to, ...(dept ? { department: dept } : {}) }));
  });

  app.get('/admin/coverage', async (c) => {
    const parsed = CoverageQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.body(null, 400);
    const dept = scopedDepartment(c.get('admin'), parsed.data.department);
    if (dept === false) return c.body(null, 403);
    return c.json(await computeCoverage(db, c.get('admin').orgId, { today: iso().slice(0, 10), ...(dept ? { department: dept } : {}) }));
  });

  // ---- 組織ポリシー（版ごとに不変。編集は新しい版を作る） ---------------------------------------
  app.get('/admin/policies', atLeast('viewer'), async (c) => {
    const rows = await db.query('SELECT p.id, p.version, p.created_at, a.email FROM policies p JOIN admins a ON a.id = p.created_by WHERE p.org_id = $1 ORDER BY p.id DESC', [c.get('admin').orgId]);
    return c.json(rows.map((r) => ({ id: Number(r.id), version: r.version, createdAt: r.created_at, createdBy: r.email })));
  });

  async function policyRow(orgId: number, id: string) {
    const n = idOf(id);
    if (n === null) return undefined;
    return db.one<{ id: number; version: string; body_json: string; created_at: string }>('SELECT id, version, body_json, created_at FROM policies WHERE org_id = $1 AND id = $2', [orgId, n]);
  }

  app.get('/admin/policies/:id', atLeast('viewer'), async (c) => {
    const row = await policyRow(c.get('admin').orgId, c.req.param('id'));
    return row ? c.json({ id: Number(row.id), version: row.version, createdAt: row.created_at, policy: JSON.parse(row.body_json) }) : c.body(null, 404);
  });

  app.post('/admin/policies', atLeast('policy_admin'), async (c) => {
    const body = (await readJson(c)) as { policy?: unknown } | undefined;
    const parsed = PolicySchema.strict().safeParse(body?.policy);
    if (!parsed.success) return c.json({ issues: issues(parsed.error) }, 400);
    // 拡張と同じ解釈で読めるか（有効期限など）まで確かめてから保存する
    const resolved = resolvePolicy(parsed.data, iso());
    if (resolved.status === 'error') return c.json({ issues: [{ path: '', message: resolved.reason }] }, 400);
    const admin = c.get('admin');
    if (await db.one('SELECT 1 FROM policies WHERE org_id = $1 AND version = $2', [admin.orgId, parsed.data.version])) {
      return c.json({ issues: [{ path: 'version', message: 'この版はすでにあります。新しい版の名前を付けてください。' }] }, 409);
    }
    const created = await db.tx(async (t) => {
      const row = (await t.one<{ id: number }>('INSERT INTO policies (org_id, version, body_json, created_by, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [admin.orgId, parsed.data.version, JSON.stringify(parsed.data), admin.id, iso()]))!;
      await audit(admin, 'policy.create', { version: parsed.data.version }, t);
      return row;
    });
    return c.json({ id: Number(created.id), version: parsed.data.version }, 201);
  });

  /** MDM に貼る JSON。google は Google 管理コンソールの拡張ポリシー形式（各項目を { Value } で包む） */
  app.get('/admin/policies/:id/export', atLeast('policy_admin'), async (c) => {
    const row = await policyRow(c.get('admin').orgId, c.req.param('id'));
    if (!row) return c.body(null, 404);
    const policy = JSON.parse(row.body_json) as Record<string, unknown>;
    const format = c.req.query('format') === 'google' ? 'google' : 'raw';
    c.header('content-disposition', `attachment; filename="text-cleaner-policy-${row.version.replace(/[^A-Za-z0-9._-]/g, '_')}-${format}.json"`);
    return c.json(format === 'google' ? googleFormat(policy) : policy);
  });

  // ---- 配布（部署ごとに配る版） -------------------------------------------------------------
  app.get('/admin/assignments', atLeast('viewer'), async (c) => {
    const rows = await db.query(`SELECT a.department, a.policy_id, a.min_extension_version, a.published_at, p.version, ad.email
      FROM policy_assignments a JOIN policies p ON p.id = a.policy_id JOIN admins ad ON ad.id = a.published_by
      WHERE a.org_id = $1 ORDER BY a.department`, [c.get('admin').orgId]);
    return c.json(rows.map((r) => ({
      department: r.department === '' ? null : r.department,
      policyId: Number(r.policy_id),
      version: r.version,
      minExtensionVersion: r.min_extension_version,
      publishedAt: r.published_at,
      publishedBy: r.email,
    })));
  });

  app.put('/admin/assignments', atLeast('policy_admin'), async (c) => {
    const parsed = AssignmentSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ issues: issues(parsed.error) }, 400);
    const admin = c.get('admin');
    const row = await policyRow(admin.orgId, String(parsed.data.policyId));
    if (!row) return c.json({ issues: [{ path: 'policyId', message: 'この版はありません。' }] }, 404);
    const resolved = resolvePolicy(JSON.parse(row.body_json), iso());
    if (resolved.status === 'error') return c.json({ issues: [{ path: 'policyId', message: resolved.reason }] }, 400);
    const dept = parsed.data.department ?? '';
    const minVersion = parsed.data.minExtensionVersion ?? null;
    await db.tx(async (t) => {
      await t.run(`INSERT INTO policy_assignments (org_id, department, policy_id, min_extension_version, published_by, published_at) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (org_id, department) DO UPDATE SET policy_id = excluded.policy_id, min_extension_version = excluded.min_extension_version,
          published_by = excluded.published_by, published_at = excluded.published_at`,
        [admin.orgId, dept, row.id, minVersion, admin.id, iso()]);
      await audit(admin, 'assignment.publish', { department: parsed.data.department, version: row.version, minExtensionVersion: minVersion }, t);
    });
    return c.body(null, 204);
  });

  app.delete('/admin/assignments', atLeast('policy_admin'), async (c) => {
    const raw = c.req.query('department');
    if (raw !== undefined && !SAFE_TOKEN.test(raw)) return c.body(null, 400);
    const admin = c.get('admin');
    const removed = await db.tx(async (t) => {
      const n = await t.run('DELETE FROM policy_assignments WHERE org_id = $1 AND department = $2', [admin.orgId, raw ?? '']);
      if (n) await audit(admin, 'assignment.remove', { department: raw ?? null }, t);
      return n;
    });
    return c.body(null, removed ? 204 : 404);
  });

  // ---- 登録トークン ------------------------------------------------------------------------
  app.get('/admin/tokens', atLeast('policy_admin'), async (c) => {
    const rows = await db.query('SELECT id, label, department, created_at, revoked_at FROM org_tokens WHERE org_id = $1 ORDER BY id DESC', [c.get('admin').orgId]);
    return c.json(rows.map((r) => ({ id: Number(r.id), label: r.label, department: r.department, createdAt: r.created_at, revokedAt: r.revoked_at })));
  });

  /** 平文のトークンは作ったときに1回だけ返す。DB にはハッシュだけを置く。MDM に貼る初期設定も一緒に返す */
  app.post('/admin/tokens', atLeast('policy_admin'), async (c) => {
    const parsed = TokenSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.body(null, 400);
    const admin = c.get('admin');
    const token = newOrgToken();
    const dept = parsed.data.department ?? null;
    const created = await db.tx(async (t) => {
      const row = (await t.one<{ id: number }>('INSERT INTO org_tokens (org_id, token_hash, label, department, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [admin.orgId, sha256(token), parsed.data.label, dept, iso()]))!;
      await audit(admin, 'token.create', { label: parsed.data.label, department: dept }, t);
      return row;
    });
    const bootstrap = { management: { endpoint: publicOrigin ?? new URL(c.req.url).origin, enrollmentToken: token, policyPublicKey: signer.publicKey } };
    return c.json({ id: Number(created.id), label: parsed.data.label, department: dept, token, bootstrap, bootstrapGoogle: googleFormat(bootstrap) }, 201);
  });

  app.delete('/admin/tokens/:id', atLeast('policy_admin'), async (c) => {
    const admin = c.get('admin');
    const id = idOf(c.req.param('id'));
    const row = id === null ? undefined : await db.one<{ label: string }>('SELECT label FROM org_tokens WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL', [admin.orgId, id]);
    if (!row) return c.body(null, 404);
    await db.tx(async (t) => {
      await t.run('UPDATE org_tokens SET revoked_at = $1 WHERE org_id = $2 AND id = $3', [iso(), admin.orgId, id]);
      await audit(admin, 'token.revoke', { label: row.label }, t);
    });
    return c.body(null, 204);
  });

  // ---- 管理者 ----------------------------------------------------------------------------
  app.get('/admin/admins', atLeast('owner'), async (c) => {
    const rows = await db.query('SELECT id, email, role, department, created_at, disabled_at FROM admins WHERE org_id = $1 ORDER BY id', [c.get('admin').orgId]);
    return c.json(rows.map((r) => ({ id: Number(r.id), email: r.email, role: r.role, department: r.department, createdAt: r.created_at, disabledAt: r.disabled_at })));
  });

  app.post('/admin/admins', atLeast('owner'), async (c) => {
    const parsed = AdminCreateSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ issues: issues(parsed.error) }, 400);
    const admin = c.get('admin');
    const email = parsed.data.email.toLowerCase();
    if (await db.one('SELECT 1 FROM admins WHERE email = $1', [email])) {
      return c.json({ issues: [{ path: 'email', message: 'このメールアドレスはすでに使われています。' }] }, 409);
    }
    const dept = parsed.data.role === 'dept_viewer' ? parsed.data.department ?? null : null;
    const passwordHash = await hashPassword(parsed.data.password);
    const created = await db.tx(async (t) => {
      const row = (await t.one<{ id: number }>('INSERT INTO admins (org_id, email, password_hash, role, department, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [admin.orgId, email, passwordHash, parsed.data.role, dept, iso()]))!;
      await audit(admin, 'admin.create', { email, role: parsed.data.role, department: dept }, t);
      return row;
    });
    return c.json({ id: Number(created.id) }, 201);
  });

  /** 有効な owner が1人もいなくなる変更は受け付けない */
  async function leavesNoOwner(orgId: number, targetId: number): Promise<boolean> {
    const owners = await db.query<{ id: number }>("SELECT id FROM admins WHERE org_id = $1 AND role = 'owner' AND disabled_at IS NULL", [orgId]);
    return owners.length === 1 && Number(owners[0]!.id) === targetId;
  }

  async function adminRow(orgId: number, id: string) {
    const n = idOf(id);
    if (n === null) return undefined;
    const row = await db.one<{ id: number; email: string; role: Role }>('SELECT id, email, role FROM admins WHERE org_id = $1 AND id = $2 AND disabled_at IS NULL', [orgId, n]);
    return row ? { ...row, id: Number(row.id) } : undefined;
  }

  app.patch('/admin/admins/:id', atLeast('owner'), async (c) => {
    const parsed = AdminUpdateSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ issues: issues(parsed.error) }, 400);
    const admin = c.get('admin');
    const target = await adminRow(admin.orgId, c.req.param('id'));
    if (!target) return c.body(null, 404);
    if (target.role === 'owner' && parsed.data.role !== 'owner' && (await leavesNoOwner(admin.orgId, target.id))) {
      return c.json({ issues: [{ path: 'role', message: 'owner が1人もいなくなるため変更できません。' }] }, 409);
    }
    const dept = parsed.data.role === 'dept_viewer' ? parsed.data.department ?? null : null;
    await db.tx(async (t) => {
      await t.run('UPDATE admins SET role = $1, department = $2 WHERE id = $3', [parsed.data.role, dept, target.id]);
      await audit(admin, 'admin.update', { email: target.email, role: parsed.data.role, department: dept }, t);
    });
    return c.body(null, 204);
  });

  /** 管理者は消さずに無効にする。ログイン中のセッションも切る */
  app.delete('/admin/admins/:id', atLeast('owner'), async (c) => {
    const admin = c.get('admin');
    const target = await adminRow(admin.orgId, c.req.param('id'));
    if (!target) return c.body(null, 404);
    if (target.id === admin.id) return c.json({ issues: [{ path: '', message: '自分自身は無効にできません。' }] }, 409);
    if (await leavesNoOwner(admin.orgId, target.id)) return c.json({ issues: [{ path: '', message: 'owner が1人もいなくなるため無効にできません。' }] }, 409);
    await db.tx(async (t) => {
      await t.run('UPDATE admins SET disabled_at = $1 WHERE id = $2', [iso(), target.id]);
      await t.run('DELETE FROM admin_sessions WHERE admin_id = $1', [target.id]);
      await audit(admin, 'admin.disable', { email: target.email }, t);
    });
    return c.body(null, 204);
  });

  registerSetup({ app, db, iso, audit, atLeast, readJson });

  // ---- 変更履歴 --------------------------------------------------------------------------
  app.get('/admin/audit', atLeast('viewer'), async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200) || 200, 1), 1000);
    const rows = await db.query('SELECT id, admin_email, action, detail_json, at FROM audit_log WHERE org_id = $1 ORDER BY id DESC LIMIT $2', [c.get('admin').orgId, limit]);
    return c.json(rows.map((r) => ({ id: Number(r.id), at: r.at, adminEmail: r.admin_email, action: r.action, detail: JSON.parse(String(r.detail_json)) })));
  });

  return app;
}

/** Google 管理コンソールの拡張ポリシー形式（各項目を { Value } で包む） */
function googleFormat(value: Record<string, unknown>): Record<string, { Value: unknown }> {
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, { Value: v }]));
}

/** 初回起動用。組織と最初の管理者（owner）を作る */
export async function createOrganization(db: Db, name: string, email: string, password: string, now = new Date()): Promise<number> {
  const passwordHash = await hashPassword(password);
  return db.tx(async (t) => {
    const org = (await t.one<{ id: number }>('INSERT INTO organizations (name, created_at) VALUES ($1, $2) RETURNING id', [name, now.toISOString()]))!;
    const orgId = Number(org.id);
    await t.run("INSERT INTO admins (org_id, email, password_hash, role, created_at) VALUES ($1, $2, $3, 'owner', $4)", [orgId, email.toLowerCase(), passwordHash, now.toISOString()]);
    return orgId;
  });
}
