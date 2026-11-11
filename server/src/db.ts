import { DatabaseSync } from 'node:sqlite';

// 管理サーバーの DB（SERVER_DESIGN.md §5・§12）。Node.js 組込みの SQLite を使い、ネイティブモジュールを足さない。
// 文章を入れる列はどのテーブルにも持たない。
// 形の変更は番号付きのマイグレーションで足す（PRAGMA user_version に適用済みの番号を持つ）。

export type Db = DatabaseSync;

/** 1: 利用記録と管理画面（v0.8.0）。既存の DB にもそのまま流せるよう IF NOT EXISTS で書く */
const V1 = `
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS org_tokens (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  version TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, version)
);
CREATE TABLE IF NOT EXISTS usage_events (
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
CREATE INDEX IF NOT EXISTS usage_events_org_hour ON usage_events (org_id, occurred_hour);
CREATE INDEX IF NOT EXISTS usage_events_org_dept_hour ON usage_events (org_id, department, occurred_hour);
CREATE TABLE IF NOT EXISTS usage_event_categories (
  event_id TEXT NOT NULL REFERENCES usage_events(event_id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  masked INTEGER NOT NULL,
  kept INTEGER NOT NULL,
  PRIMARY KEY (event_id, category)
);
CREATE TABLE IF NOT EXISTS usage_event_blockers (
  event_id TEXT NOT NULL REFERENCES usage_events(event_id) ON DELETE CASCADE,
  blocker_kind TEXT NOT NULL,
  PRIMARY KEY (event_id, blocker_kind)
);
`;

/** 2: 一元管理。管理者の役割、部署ごとの登録トークンと配布、適用状況、変更履歴 */
const V2 = `
ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE admins ADD COLUMN department TEXT;
-- 管理者は消さずに無効にする（作ったポリシー・変更履歴との結び付きを残す）
ALTER TABLE admins ADD COLUMN disabled_at TEXT;
ALTER TABLE org_tokens ADD COLUMN department TEXT;
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
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  admin_id INTEGER,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX audit_log_org_at ON audit_log (org_id, at);
`;

/** 3: 初回の案内（はじめての設定）。相談先・選んだひな形・部署の日本語名と、案内の進み具合 */
const V3 = `
ALTER TABLE organizations ADD COLUMN contact TEXT;
ALTER TABLE organizations ADD COLUMN default_preset TEXT;
ALTER TABLE organizations ADD COLUMN collect_usage INTEGER NOT NULL DEFAULT 1;
ALTER TABLE organizations ADD COLUMN setup_org_at TEXT;
ALTER TABLE organizations ADD COLUMN setup_departments_at TEXT;
CREATE TABLE departments (
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  preset TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, code)
);
`;

/** 試験で古い DB を作るために公開する */
export const MIGRATIONS = [V1, V2, V3];

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** 複数の書込みを1つのトランザクションにまとめる */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 適用状況は、この日数のあいだ報告のない端末の分を消す */
export const DEVICE_STATUS_DAYS = 90;

/** 保存期間（利用記録は13か月、適用状況は90日）を過ぎたものを消す。消した件数を返す */
export function deleteExpiredEvents(db: Db, now: Date): number {
  const cutoff = new Date(now.getTime() - 395 * 24 * 60 * 60 * 1000).toISOString().slice(0, 13) + ':00Z';
  const events = Number(db.prepare('DELETE FROM usage_events WHERE occurred_hour < ?').run(cutoff).changes);
  const statusCutoff = new Date(now.getTime() - DEVICE_STATUS_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const statuses = Number(db.prepare('DELETE FROM device_status WHERE reported_day < ?').run(statusCutoff).changes);
  return events + statuses;
}
