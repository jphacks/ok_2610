import type { Context, Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { PRESET_IDS, presetOf, presetPolicy, type PresetId } from '../../shared/policy-presets';
import { SAFE_TOKEN } from '../../shared/usage-event';
import { PolicySchema, resolvePolicy } from '../../src/core/policy';
import type { AppEnv, Role } from './app';
import { COVERAGE_DAYS } from './coverage';
import type { Db } from './db';

// 初回の案内（はじめての設定、SERVER_DESIGN.md §13）。
// 管理者が専門用語に触れずに、組織の情報 → ルール → 部署 → 端末に配る → つながったか確認、の順に進められるようにする。
// ここで作るポリシー・配布・トークンは、ふつうの画面で作るものと同じ（版は不変、変更履歴に残る）。

type Admin = AppEnv['Variables']['admin'];
type Deps = {
  app: Hono<AppEnv>;
  db: Db;
  iso: () => string;
  audit: (admin: Admin, action: string, detail: Record<string, unknown>, q?: Db) => Promise<void>;
  atLeast: (role: Role) => MiddlewareHandler<AppEnv>;
  readJson: (c: Context) => Promise<unknown>;
};

const preset = z.enum(PRESET_IDS);
const OrganizationSchema = z.strictObject({ name: z.string().trim().min(1).max(80), contact: z.string().trim().max(120) });
const RulesSchema = z.strictObject({ preset, collectUsage: z.boolean() });
const DepartmentsSchema = z.strictObject({
  mode: z.enum(['split', 'whole']),
  departments: z
    .array(z.strictObject({ code: z.string().regex(SAFE_TOKEN).optional(), name: z.string().trim().min(1).max(40), preset }))
    .max(50),
});

type Org = { name: string; contact: string | null; default_preset: string | null; collect_usage: boolean; setup_org_at: string | null; setup_departments_at: string | null };
type Department = { code: string; name: string; preset: PresetId };

/** 項目の順番に左右されない比較用の文字列（保存時の検証で項目の順番が変わるため） */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const issues = (error: z.ZodError) => error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

export function registerSetup({ app, db, iso, audit, atLeast, readJson }: Deps): void {
  const org = async (q: Db, orgId: number) =>
    (await q.one<Org>('SELECT name, contact, default_preset, collect_usage, setup_org_at, setup_departments_at FROM organizations WHERE id = $1', [orgId]))!;
  const departments = async (q: Db, orgId: number): Promise<Department[]> =>
    (await q.query('SELECT code, name, preset FROM departments WHERE org_id = $1 ORDER BY code', [orgId]))
      .map((r) => ({ code: String(r.code), name: String(r.name), preset: String(r.preset) as PresetId }));

  /** 中身が同じ版がすでにあればそれを使い、なければ「ひな形-日付」の版を作る（同じ設定を保存し直しても版を増やさない） */
  async function findOrCreatePolicy(q: Db, admin: Admin, presetId: PresetId): Promise<{ id: number; version: string }> {
    const o = await org(q, admin.orgId);
    const body = presetPolicy(presetOf(presetId)!, { name: o.name, contact: o.contact, collectUsage: Boolean(o.collect_usage) });
    const key = canonical(body);
    for (const r of await q.query('SELECT id, version, body_json FROM policies WHERE org_id = $1 ORDER BY id DESC', [admin.orgId])) {
      const rest = JSON.parse(String(r.body_json)) as Record<string, unknown>;
      delete rest.version;
      if (canonical(rest) === key) return { id: Number(r.id), version: String(r.version) };
    }
    const base = `${presetId}-${iso().slice(0, 10).replace(/-/g, '')}`;
    let version = base;
    for (let n = 2; await q.one('SELECT 1 FROM policies WHERE org_id = $1 AND version = $2', [admin.orgId, version]); n++) version = `${base}-${n}`;
    const policy = PolicySchema.strict().parse({ version, ...body });
    if (resolvePolicy(policy, iso()).status !== 'active') throw new Error('ひな形から作ったポリシーを読めません');
    const row = (await q.one<{ id: number }>('INSERT INTO policies (org_id, version, body_json, created_by, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [admin.orgId, version, JSON.stringify(policy), admin.id, iso()]))!;
    await audit(admin, 'policy.create', { version }, q);
    return { id: Number(row.id), version };
  }

  /** 部署（'' は全社の既定）に配る版を決める。拡張の最低版は、決めてあればそのまま残す */
  async function assign(q: Db, admin: Admin, department: string, policy: { id: number; version: string }) {
    const current = await q.one<{ policy_id: number }>('SELECT policy_id FROM policy_assignments WHERE org_id = $1 AND department = $2', [admin.orgId, department]);
    if (current && Number(current.policy_id) === policy.id) return;
    await q.run(`INSERT INTO policy_assignments (org_id, department, policy_id, min_extension_version, published_by, published_at) VALUES ($1, $2, $3, NULL, $4, $5)
      ON CONFLICT (org_id, department) DO UPDATE SET policy_id = excluded.policy_id, published_by = excluded.published_by, published_at = excluded.published_at`,
      [admin.orgId, department, policy.id, admin.id, iso()]);
    await audit(admin, 'assignment.publish', { department: department || null, version: policy.version, minExtensionVersion: null }, q);
  }

  /** 進み具合。どの手順が済んだかは、作られたデータから決める */
  app.get('/admin/setup', atLeast('policy_admin'), async (c) => {
    const { orgId } = c.get('admin');
    const o = await org(db, orgId);
    const depts = await departments(db, orgId);
    const from = new Date(Date.parse(`${iso().slice(0, 10)}T00:00:00Z`) - (COVERAGE_DAYS - 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const steps = {
      organization: o.setup_org_at !== null,
      rules: !!(await db.one("SELECT 1 FROM policy_assignments WHERE org_id = $1 AND department = ''", [orgId])),
      departments: o.setup_departments_at !== null,
      distribute: !!(await db.one('SELECT 1 FROM org_tokens WHERE org_id = $1 AND revoked_at IS NULL', [orgId])),
      connected: !!(await db.one('SELECT 1 FROM device_status WHERE org_id = $1 AND reported_day >= $2', [orgId, from])),
    };
    return c.json({
      organization: { name: o.name, contact: o.contact },
      defaultPreset: o.default_preset,
      collectUsage: Boolean(o.collect_usage),
      departmentMode: o.setup_departments_at === null ? null : depts.length ? 'split' : 'whole',
      departments: depts,
      steps,
      complete: Object.values(steps).every(Boolean),
    });
  });

  app.put('/admin/setup/organization', atLeast('policy_admin'), async (c) => {
    const parsed = OrganizationSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ issues: issues(parsed.error) }, 400);
    const admin = c.get('admin');
    await db.tx(async (t) => {
      await t.run('UPDATE organizations SET name = $1, contact = $2, setup_org_at = COALESCE(setup_org_at, $3) WHERE id = $4',
        [parsed.data.name, parsed.data.contact || null, iso(), admin.orgId]);
      await audit(admin, 'organization.update', { name: parsed.data.name, contact: parsed.data.contact || null }, t);
    });
    return c.body(null, 204);
  });

  /** 全社の既定のルールを、ひな形から作って配る */
  app.put('/admin/setup/rules', atLeast('policy_admin'), async (c) => {
    const parsed = RulesSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ issues: issues(parsed.error) }, 400);
    const admin = c.get('admin');
    await db.tx(async (t) => {
      await t.run('UPDATE organizations SET default_preset = $1, collect_usage = $2 WHERE id = $3', [parsed.data.preset, parsed.data.collectUsage, admin.orgId]);
      await assign(t, admin, '', await findOrCreatePolicy(t, admin, parsed.data.preset));
      // 利用記録を集めるかを変えたら、部署ごとのルールにも反映する
      for (const d of await departments(t, admin.orgId)) await assign(t, admin, d.code, await findOrCreatePolicy(t, admin, d.preset));
    });
    return c.body(null, 204);
  });

  /**
   * 部署を登録し、部署ごとのルールを配る。管理用の名前（dept-01 など）は自動で付ける。
   * 「全社で同じにする」なら、案内で作った部署と、その部署への配布を外す（ふつうの画面で作った配布には触れない）。
   */
  app.put('/admin/setup/departments', atLeast('policy_admin'), async (c) => {
    const parsed = DepartmentsSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ issues: issues(parsed.error) }, 400);
    const admin = c.get('admin');
    const wanted = parsed.data.mode === 'whole' ? [] : parsed.data.departments;
    const names = wanted.map((d) => d.name);
    if (new Set(names).size !== names.length) return c.json({ issues: [{ path: 'departments', message: '同じ部署名が2回あります。' }] }, 400);
    const saved = await db.tx(async (t) => {
      const existing = await departments(t, admin.orgId);
      const known = new Set(existing.map((d) => d.code));
      let next = Math.max(0, ...existing.map((d) => Number(/^dept-(\d+)$/.exec(d.code)?.[1] ?? 0))) + 1;
      const list = wanted.map((d) => (d.code && known.has(d.code) ? { ...d, code: d.code } : { ...d, code: `dept-${String(next++).padStart(2, '0')}` }));
      const keep = new Set(list.map((d) => d.code));
      for (const d of existing) {
        if (keep.has(d.code)) continue;
        await t.run('DELETE FROM departments WHERE org_id = $1 AND code = $2', [admin.orgId, d.code]);
        if (await t.run('DELETE FROM policy_assignments WHERE org_id = $1 AND department = $2', [admin.orgId, d.code])) {
          await audit(admin, 'assignment.remove', { department: d.code }, t);
        }
      }
      for (const d of list) {
        await t.run(`INSERT INTO departments (org_id, code, name, preset, created_at) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (org_id, code) DO UPDATE SET name = excluded.name, preset = excluded.preset`, [admin.orgId, d.code, d.name, d.preset, iso()]);
        await assign(t, admin, d.code, await findOrCreatePolicy(t, admin, d.preset));
      }
      await t.run('UPDATE organizations SET setup_departments_at = $1 WHERE id = $2', [iso(), admin.orgId]);
      await audit(admin, 'departments.save', { mode: parsed.data.mode, departments: list.map((d) => ({ code: d.code, name: d.name, preset: d.preset })) }, t);
      return departments(t, admin.orgId);
    });
    return c.json({ departments: saved });
  });

  /** 部署の日本語名。画面で管理用の名前の代わりに出す */
  app.get('/admin/departments', atLeast('dept_viewer'), async (c) => {
    const admin = c.get('admin');
    const all = await departments(db, admin.orgId);
    return c.json(admin.role === 'dept_viewer' ? all.filter((d) => d.code === admin.department) : all);
  });
}
