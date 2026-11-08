import { DatabaseSync } from 'node:sqlite';

// 利用記録サーバーの DB（SERVER_DESIGN.md §5）。Node.js 組込みの SQLite を使い、ネイティブモジュールを足さない。
// 文章を入れる列はどのテーブルにも持たない。

export type Db = DatabaseSync;

const SCHEMA = `
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

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
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

/** 保存期間（13か月）を過ぎた記録を消す。消した件数を返す */
export function deleteExpiredEvents(db: Db, now: Date): number {
  const cutoff = new Date(now.getTime() - 395 * 24 * 60 * 60 * 1000).toISOString().slice(0, 13) + ':00Z';
  return Number(db.prepare('DELETE FROM usage_events WHERE occurred_hour < ?').run(cutoff).changes);
}
