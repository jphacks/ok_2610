import type { Db } from './db';

// 管理画面の集計（SERVER_DESIGN.md §6）。利用者個人ごとの集計は作らない。
// 部署を絞り込んだとき、その部署・期間の記録が少ないと数字そのものが手がかりになるので、5件未満は数字を返さない。

export const MIN_GROUP = 5;

export type StatsQuery = { from: string; to: string; department?: string };

type Row = Record<string, string | number | null>;
const num = (v: unknown) => Number(v ?? 0);

export type Stats = {
  from: string;
  to: string;
  department: string | null;
  /** 部署で絞り込み、件数が MIN_GROUP 未満のとき true。数字は返さない */
  suppressed: boolean;
  totals: { outputs: number; blocked: number };
  byDestination: { destination: string; count: number }[];
  masked: { category: string; count: number }[];
  kept: { category: string; count: number }[];
  riskLevels: { level: string; count: number }[];
  blockers: { kind: string; count: number }[];
  daily: { date: string; outputs: number; blocked: number }[];
  /** 部署別の出力回数。MIN_GROUP 未満は count を null にする */
  departments: { department: string; count: number | null }[];
};

/** YYYY-MM-DD の範囲を、occurred_hour と比べられる文字列の半開区間にする */
function range(q: StatsQuery): [string, string] {
  const end = new Date(`${q.to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return [`${q.from}T00:00Z`, `${end.toISOString().slice(0, 10)}T00:00Z`];
}

export async function computeStats(db: Db, orgId: number, q: StatsQuery): Promise<Stats> {
  const [start, end] = range(q);
  const dept = q.department ?? null;
  const where = `e.org_id = $1 AND e.occurred_hour >= $2 AND e.occurred_hour < $3${dept ? ' AND e.department = $4' : ''}`;
  const args = dept ? [orgId, start, end, dept] : [orgId, start, end];
  const all = (sql: string) => db.query(sql, args) as Promise<Row[]>;

  const kinds = await all(`SELECT e.kind AS kind, COUNT(*) AS n FROM usage_events e WHERE ${where} GROUP BY e.kind`);
  const totals = {
    outputs: num(kinds.find((r) => r.kind === 'output')?.n),
    blocked: num(kinds.find((r) => r.kind === 'blocked')?.n),
  };
  const empty: Stats = {
    from: q.from, to: q.to, department: dept, suppressed: false, totals,
    byDestination: [], masked: [], kept: [], riskLevels: [], blockers: [], daily: [], departments: [],
  };
  if (dept && totals.outputs + totals.blocked < MIN_GROUP) {
    return { ...empty, suppressed: true, totals: { outputs: 0, blocked: 0 } };
  }

  const [byDestination, masked, kept, riskLevels, blockers, daily, departments] = await Promise.all([
    all(`SELECT e.destination AS destination, COUNT(*) AS n FROM usage_events e WHERE ${where} AND e.kind = 'output' GROUP BY e.destination ORDER BY n DESC`)
      .then((rs) => rs.map((r) => ({ destination: String(r.destination), count: num(r.n) }))),
    all(`SELECT c.category AS category, SUM(c.masked) AS n FROM usage_event_categories c JOIN usage_events e ON e.event_id = c.event_id WHERE ${where} AND e.kind = 'output' GROUP BY c.category HAVING SUM(c.masked) > 0 ORDER BY n DESC`)
      .then((rs) => rs.map((r) => ({ category: String(r.category), count: num(r.n) }))),
    all(`SELECT c.category AS category, SUM(c.kept) AS n FROM usage_event_categories c JOIN usage_events e ON e.event_id = c.event_id WHERE ${where} AND e.kind = 'output' GROUP BY c.category HAVING SUM(c.kept) > 0 ORDER BY n DESC`)
      .then((rs) => rs.map((r) => ({ category: String(r.category), count: num(r.n) }))),
    all(`SELECT e.risk_level AS level, COUNT(*) AS n FROM usage_events e WHERE ${where} AND e.kind = 'output' AND e.risk_level IS NOT NULL GROUP BY e.risk_level`)
      .then((rs) => rs.map((r) => ({ level: String(r.level), count: num(r.n) }))),
    all(`SELECT b.blocker_kind AS kind, COUNT(*) AS n FROM usage_event_blockers b JOIN usage_events e ON e.event_id = b.event_id WHERE ${where} GROUP BY b.blocker_kind ORDER BY n DESC`)
      .then((rs) => rs.map((r) => ({ kind: String(r.kind), count: num(r.n) }))),
    all(`SELECT substr(e.occurred_hour, 1, 10) AS day, SUM(CASE WHEN e.kind = 'output' THEN 1 ELSE 0 END) AS outputs, SUM(CASE WHEN e.kind = 'blocked' THEN 1 ELSE 0 END) AS blocked FROM usage_events e WHERE ${where} GROUP BY day ORDER BY day`)
      .then((rs) => rs.map((r) => ({ date: String(r.day), outputs: num(r.outputs), blocked: num(r.blocked) }))),
    dept
      ? Promise.resolve([])
      : all(`SELECT e.department AS department, COUNT(*) AS n FROM usage_events e WHERE ${where} AND e.kind = 'output' AND e.department IS NOT NULL GROUP BY e.department ORDER BY n DESC`)
          .then((rs) => rs.map((r) => ({ department: String(r.department), count: num(r.n) >= MIN_GROUP ? num(r.n) : null }))),
  ]);
  return { ...empty, byDestination, masked, kept, riskLevels, blockers, daily, departments };
}
