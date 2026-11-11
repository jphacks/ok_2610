import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

// 管理サーバーの DB（SERVER_DESIGN.md §5・§12・§14）。PostgreSQL を使う。
// - 本番（無料のクラウドなど）：DATABASE_URL の PostgreSQL（例 Neon）。サーバーのディスクにデータを置かない
// - 試験・手元の開発：PGlite（WASM で動く PostgreSQL。ネイティブモジュールなし）。メモリかフォルダに置く
// どちらも同じ SQL（PostgreSQL の方言、プレースホルダは $1, $2 …）で読み書きする。
// 文章を入れる列はどのテーブルにも持たない。形の変更は番号付きのマイグレーションで足す。

export type Row = Record<string, unknown>;

export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** 書き換えた行の数を返す */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** fn の中の読み書きを1つのトランザクションにまとめる。fn が投げれば巻き戻す */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Exec = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; count: number }> };

function wrap(exec: Exec, tx: Db['tx'], close: () => Promise<void>): Db {
  return {
    query: async <T extends Row>(sql: string, params: unknown[] = []) => (await exec.query(sql, params)).rows as T[],
    one: async <T extends Row>(sql: string, params: unknown[] = []) => (await exec.query(sql, params)).rows[0] as T | undefined,
    run: async (sql: string, params: unknown[] = []) => (await exec.query(sql, params)).count,
    tx,
    close,
  };
}

/** PostgreSQL（本番）。接続先は DATABASE_URL（例 postgresql://…?sslmode=require） */
function postgres(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const exec = (client: pg.Pool | pg.PoolClient): Exec => ({
    query: async (sql, params) => {
      const r = await client.query(sql, params);
      return { rows: r.rows as Row[], count: r.rowCount ?? 0 };
    },
  });
  const db: Db = wrap(
    exec(pool),
    async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inner = wrap(exec(client), (f) => f(inner), async () => undefined);
        const out = await fn(inner);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    () => pool.end(),
  );
  return db;
}

/** PGlite（試験・手元の開発）。dataDir がなければメモリに置く。クラウド（Vercel）の関数には PGlite を入れないので、使うときだけ読み込む */
async function pglite(dataDir: string | undefined): Promise<Db> {
  const { PGlite: Lite } = await import('@electric-sql/pglite');
  const lite: PGlite = new Lite(dataDir);
  type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> };
  const exec = (q: Q): Exec => ({
    query: async (sql, params) => {
      const r = await q.query(sql, params);
      return { rows: r.rows as Row[], count: r.affectedRows ?? 0 };
    },
  });
  return wrap(
    exec(lite),
    (fn) => lite.transaction(async (t) => {
      const inner: Db = wrap(exec(t), (f) => f(inner), async () => undefined);
      return fn(inner);
    }),
    () => lite.close(),
  );
}

/** 1: 管理サーバーのすべての表（利用記録・一元管理・はじめての設定） */
const V1 = `
CREATE TABLE organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  default_preset TEXT,
  collect_usage BOOLEAN NOT NULL DEFAULT TRUE,
  setup_org_at TEXT,
  setup_departments_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE admins (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  department TEXT,
  -- 管理者は消さずに無効にする（作ったポリシー・変更履歴との結び付きを残す）
  disabled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE org_tokens (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  department TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE policies (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  version TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, version)
);
CREATE TABLE usage_events (
  event_id TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL,
  occurred_hour TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  policy_version TEXT,
  department TEXT,
  stage TEXT NOT NULL,
  purpose TEXT NOT NULL,
  destination TEXT,
  risk_level TEXT,
  manual_ops INTEGER NOT NULL,
  ner TEXT NOT NULL,
  nano TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX usage_events_org_hour ON usage_events (org_id, occurred_hour);
CREATE INDEX usage_events_org_dept_hour ON usage_events (org_id, department, occurred_hour);
CREATE TABLE usage_event_categories (
  event_id TEXT NOT NULL REFERENCES usage_events(event_id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  masked INTEGER NOT NULL,
  kept INTEGER NOT NULL,
  PRIMARY KEY (event_id, category)
);
CREATE TABLE usage_event_blockers (
  event_id TEXT NOT NULL REFERENCES usage_events(event_id) ON DELETE CASCADE,
  blocker_kind TEXT NOT NULL,
  PRIMARY KEY (event_id, blocker_kind)
);
CREATE TABLE policy_assignments (
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  department TEXT NOT NULL,
  policy_id INTEGER NOT NULL REFERENCES policies(id),
  min_extension_version TEXT,
  published_by INTEGER NOT NULL REFERENCES admins(id),
  published_at TEXT NOT NULL,
  PRIMARY KEY (org_id, department)
);
CREATE TABLE device_status (
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  install_id TEXT NOT NULL,
  reported_day TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  policy_version TEXT,
  policy_state TEXT NOT NULL,
  policy_source TEXT NOT NULL,
  department TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (org_id, install_id)
);
CREATE INDEX device_status_org_day ON device_status (org_id, reported_day);
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  admin_id INTEGER,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX audit_log_org_at ON audit_log (org_id, at);
CREATE TABLE departments (
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  preset TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, code)
);
`;

/**
 * 2: 管理者のログインの失敗（5回で15分止める）。Vercel ではサーバーが要求ごとに別々に動くことがあり、
 * メモリに数えると止まらないので DB に置く。メールアドレスと時刻だけを持ち、1日たてば消す
 */
const V2 = `
CREATE TABLE login_failures (
  email TEXT NOT NULL,
  failed_at TEXT NOT NULL
);
CREATE INDEX login_failures_email_at ON login_failures (email, failed_at)
`;

/** 試験で適用の順番を確かめるために公開する */
export const MIGRATIONS = [V1, V2];

/** マイグレーションを同時に流さないための鍵（PostgreSQL の advisory lock の番号） */
const MIGRATION_LOCK = 2610;

/**
 * DB を開いてマイグレーションを流す。url があれば PostgreSQL、なければ PGlite（dataDir がなければメモリ）。
 */
export async function openDb(opts: { url?: string | undefined; dataDir?: string | undefined } = {}): Promise<Db> {
  const db = opts.url ? postgres(opts.url) : await pglite(opts.dataDir);
  await migrate(db);
  return db;
}

// Vercel では、眠りから覚めた関数がいくつも同時に起動することがある。advisory lock で1つずつ流し、
// 鍵を取ったあとで、ほかが先に流していないかを確かめ直す
async function migrate(db: Db): Promise<void> {
  await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await t.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  });
  const done = new Set((await db.query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
  for (let v = 1; v <= MIGRATIONS.length; v++) {
    if (done.has(v)) continue;
    await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      if (await t.one('SELECT 1 FROM schema_migrations WHERE version = $1', [v])) return;
      for (const statement of MIGRATIONS[v - 1]!.split(';').map((s) => s.trim()).filter((s) => s && !/^--[^\n]*$/.test(s))) {
        await t.run(statement);
      }
      await t.run('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [v, new Date().toISOString()]);
    });
  }
}

/** 適用状況は、この日数のあいだ報告のない端末の分を消す */
export const DEVICE_STATUS_DAYS = 90;

/** 保存期間（利用記録は13か月、適用状況は90日）を過ぎたものを消す。消した件数を返す */
export async function deleteExpiredEvents(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 395 * 24 * 60 * 60 * 1000).toISOString().slice(0, 13) + ':00Z';
  const events = await db.run('DELETE FROM usage_events WHERE occurred_hour < $1', [cutoff]);
  const statusCutoff = new Date(now.getTime() - DEVICE_STATUS_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const statuses = await db.run('DELETE FROM device_status WHERE reported_day < $1', [statusCutoff]);
  // ログインの失敗は15分しか使わないので、1日たったものを消す（件数には数えない）
  await db.run('DELETE FROM login_failures WHERE failed_at < $1', [new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()]);
  return events + statuses;
}
