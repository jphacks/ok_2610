import { POLICY_STATES, type PolicyState } from '../../shared/management';
import type { Db } from './db';

// 適用状況の集計（SERVER_DESIGN.md §12-5）。端末ごとの一覧は返さず、部署・版ごとの台数だけを返す。

/** 直近この日数のあいだに報告した端末を数える */
export const COVERAGE_DAYS = 7;

export type Coverage = {
  from: string;
  to: string;
  department: string | null;
  totals: { devices: number; current: number; stopped: number };
  /** department が null の行は、部署のない登録トークン（全社） */
  departments: {
    department: string | null;
    /** その部署に配っている版（部署の割り当てがなければ全社の既定） */
    assignedVersion: string | null;
    devices: number;
    /** 配っている版を、止まらずに適用している台数 */
    current: number;
    states: Record<PolicyState, number>;
  }[];
  extensionVersions: { version: string; count: number }[];
};


const emptyStates = (): Record<PolicyState, number> => Object.fromEntries(POLICY_STATES.map((s) => [s, 0])) as Record<PolicyState, number>;

export async function computeCoverage(db: Db, orgId: number, q: { today: string; department?: string }): Promise<Coverage> {
  const start = new Date(`${q.today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (COVERAGE_DAYS - 1));
  const from = start.toISOString().slice(0, 10);
  const dept = q.department ?? null;

  const assigned = new Map<string, string>();
  for (const r of await db.query('SELECT a.department, p.version FROM policy_assignments a JOIN policies p ON p.id = a.policy_id WHERE a.org_id = $1', [orgId])) {
    assigned.set(String(r.department), String(r.version));
  }
  const versionFor = (d: string | null) => assigned.get(d ?? '') ?? assigned.get('') ?? null;

  const rows = await db.query(`SELECT department, policy_state, policy_version, extension_version, COUNT(*) AS n FROM device_status
      WHERE org_id = $1 AND reported_day >= $2 AND reported_day <= $3${dept ? ' AND department = $4' : ''}
      GROUP BY department, policy_state, policy_version, extension_version`, dept ? [orgId, from, q.today, dept] : [orgId, from, q.today]);

  const byDept = new Map<string, Coverage['departments'][number]>();
  const byExt = new Map<string, number>();
  for (const r of rows) {
    const d = r.department === null ? null : String(r.department);
    const key = d ?? '';
    const n = Number(r.n);
    const entry = byDept.get(key) ?? { department: d, assignedVersion: versionFor(d), devices: 0, current: 0, states: emptyStates() };
    entry.devices += n;
    entry.states[r.policy_state as PolicyState] += n;
    if (r.policy_state === 'active' && entry.assignedVersion !== null && r.policy_version === entry.assignedVersion) entry.current += n;
    byDept.set(key, entry);
    byExt.set(String(r.extension_version), (byExt.get(String(r.extension_version)) ?? 0) + n);
  }
  // 割り当てがあるのに報告がまだない部署も、0台として見せる
  for (const d of assigned.keys()) {
    if (d === '' || byDept.has(d) || (dept && d !== dept)) continue;
    byDept.set(d, { department: d, assignedVersion: versionFor(d), devices: 0, current: 0, states: emptyStates() });
  }

  const departments = [...byDept.values()].sort((a, b) => (a.department ?? '').localeCompare(b.department ?? ''));
  const devices = departments.reduce((s, d) => s + d.devices, 0);
  const current = departments.reduce((s, d) => s + d.current, 0);
  return {
    from,
    to: q.today,
    department: dept,
    totals: { devices, current, stopped: departments.reduce((s, d) => s + d.devices - d.states.active, 0) },
    departments,
    extensionVersions: [...byExt].map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
  };
}
