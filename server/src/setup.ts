import type { Context, Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { PRESET_IDS, presetOf, presetPolicy, type PresetId } from '../../shared/policy-presets';
import { SAFE_TOKEN } from '../../shared/usage-event';
import { PolicySchema, resolvePolicy } from '../../src/core/policy';
import type { AppEnv, Role } from './app';
import { COVERAGE_DAYS } from './coverage';
import { transaction, type Db } from './db';

// 初回の案内（はじめての設定、SERVER_DESIGN.md §13）。
// 管理者が専門用語に触れずに、組織の情報 → ルール → 部署 → 端末に配る → つながったか確認、の順に進められるようにする。
// ここで作るポリシー・配布・トークンは、ふつうの画面で作るものと同じ（版は不変、変更履歴に残る）。

type Admin = AppEnv['Variables']['admin'];
type Deps = {
  app: Hono<AppEnv>;
  db: Db;
  iso: () => string;
  audit: (admin: Admin, action: string, detail: Record<string, unknown>) => void;
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

type Row = Record<string, string | number | null>;
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
  const org = (orgId: number) =>
    db.prepare('SELECT name, contact, default_preset, collect_usage, setup_org_at, setup_departments_at FROM organizations WHERE id = ?').get(orgId) as Row;
  const departments = (orgId: number) =>
    (db.prepare('SELECT code, name, preset FROM departments WHERE org_id = ? ORDER BY code').all(orgId) as Row[]).map((r) => ({ code: String(r.code), name: String(r.name), preset: String(r.preset) as PresetId }));

  /** 中身が同じ版がすでにあればそれを使い、なければ「ひな形-日付」の版を作る（同じ設定を保存し直しても版を増やさない） */
  function findOrCreatePolicy(admin: Admin, presetId: PresetId): { id: number; version: string } {
    const o = org(admin.orgId);
    const body = presetPolicy(presetOf(presetId)!, { name: String(o.name), contact: o.contact === null ? null : String(o.contact), collectUsage: Number(o.collect_usage) === 1 });
    const key = canonical(body);
    for (const r of db.prepare('SELECT id, version, body_json FROM policies WHERE org_id = ? ORDER BY id DESC').all(admin.orgId) as Row[]) {
      const rest = JSON.parse(String(r.body_json)) as Record<string, unknown>;
      delete rest.version;
      if (canonical(rest) === key) return { id: Number(r.id), version: String(r.version) };
    }
    const base = `${presetId}-${iso().slice(0, 10).replace(/-/g, '')}`;
    let version = base;
    for (let n = 2; db.prepare('SELECT 1 FROM policies WHERE org_id = ? AND version = ?').get(admin.orgId, version); n++) version = `${base}-${n}`;
    const policy = PolicySchema.strict().parse({ version, ...body });
    if (resolvePolicy(policy, iso()).status !== 'active') throw new Error('ひな形から作ったポリシーを読めません');
    const result = db.prepare('INSERT INTO policies (org_id, version, body_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(admin.orgId, version, JSON.stringify(policy), admin.id, iso());
    audit(admin, 'policy.create', { version });
    return { id: Number(result.lastInsertRowid), version };
  }

  /** 部署（'' は全社の既定）に配る版を決める。拡張の最低版は、決めてあればそのまま残す */
  function assign(admin: Admin, department: string, policy: { id: number; version: string }) {
    const current = db.prepare('SELECT policy_id FROM policy_assignments WHERE org_id = ? AND department = ?').get(admin.orgId, department) as { policy_id: number } | undefined;
    if (current?.policy_id === policy.id) return;
    db.prepare(`INSERT INTO policy_assignments (org_id, department, policy_id, min_extension_version, published_by, published_at) VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT (org_id, department) DO UPDATE SET policy_id = excluded.policy_id, published_by = excluded.published_by, published_at = excluded.published_at`)
      .run(admin.orgId, department, policy.id, admin.id, iso());
    audit(admin, 'assignment.publish', { department: department || null, version: policy.version, minExtensionVersion: null });
  }

  /** 進み具合。どの手順が済んだかは、作られたデータから決める */
  app.get('/admin/setup', atLeast('policy_admin'), (c) => {
    const { orgId } = c.get('admin');
    const o = org(orgId);
    const depts = departments(orgId);
    const from = new Date(Date.parse(`${iso().slice(0, 10)}T00:00:00Z`) - (COVERAGE_DAYS - 1) * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const steps = {
      organization: o.setup_org_at !== null,
      rules: !!db.prepare("SELECT 1 FROM policy_assignments WHERE org_id = ? AND department = ''").get(orgId),
      departments: o.setup_departments_at !== null,
      distribute: !!db.prepare('SELECT 1 FROM org_tokens WHERE org_id = ? AND revoked_at IS NULL').get(orgId),
      connected: !!db.prepare('SELECT 1 FROM device_status WHERE org_id = ? AND reported_day >= ?').get(orgId, from),
    };
    return c.json({
      organization: { name: o.name, contact: o.contact },
      defaultPreset: o.default_preset,
      collectUsage: Number(o.collect_usage) === 1,
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
    db.prepare('UPDATE organizations SET name = ?, contact = ?, setup_org_at = COALESCE(setup_org_at, ?) WHERE id = ?')
      .run(parsed.data.name, parsed.data.contact || null, iso(), admin.orgId);
    audit(admin, 'organization.update', { name: parsed.data.name, contact: parsed.data.contact || null });
    return c.body(null, 204);
  });

  /** 全社の既定のルールを、ひな形から作って配る */
  app.put('/admin/setup/rules', atLeast('policy_admin'), async (c) => {
    const parsed = RulesSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ issues: issues(parsed.error) }, 400);
    const admin = c.get('admin');
    transaction(db, () => {
      db.prepare('UPDATE organizations SET default_preset = ?, collect_usage = ? WHERE id = ?').run(parsed.data.preset, parsed.data.collectUsage ? 1 : 0, admin.orgId);
      assign(admin, '', findOrCreatePolicy(admin, parsed.data.preset));
      // 利用記録を集めるかを変えたら、部署ごとのルールにも反映する
      for (const d of departments(admin.orgId)) assign(admin, d.code, findOrCreatePolicy(admin, d.preset));
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
    const existing = departments(admin.orgId);
    const known = new Set(existing.map((d) => d.code));
    let next = Math.max(0, ...existing.map((d) => Number(/^dept-(\d+)$/.exec(d.code)?.[1] ?? 0))) + 1;
    const saved = wanted.map((d) => {
      if (d.code && known.has(d.code)) return { ...d, code: d.code };
      const code = `dept-${String(next++).padStart(2, '0')}`;
      return { ...d, code };
    });
    transaction(db, () => {
      const keep = new Set(saved.map((d) => d.code));
      for (const d of existing) {
        if (keep.has(d.code)) continue;
        db.prepare('DELETE FROM departments WHERE org_id = ? AND code = ?').run(admin.orgId, d.code);
        if (db.prepare('DELETE FROM policy_assignments WHERE org_id = ? AND department = ?').run(admin.orgId, d.code).changes) {
          audit(admin, 'assignment.remove', { department: d.code });
        }
      }
      for (const d of saved) {
        db.prepare(`INSERT INTO departments (org_id, code, name, preset, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (org_id, code) DO UPDATE SET name = excluded.name, preset = excluded.preset`).run(admin.orgId, d.code, d.name, d.preset, iso());
        assign(admin, d.code, findOrCreatePolicy(admin, d.preset));
      }
      db.prepare('UPDATE organizations SET setup_departments_at = ? WHERE id = ?').run(iso(), admin.orgId);
    });
    audit(admin, 'departments.save', { mode: parsed.data.mode, departments: saved.map((d) => ({ code: d.code, name: d.name, preset: d.preset })) });
    return c.json({ departments: departments(admin.orgId) });
  });

  /** 部署の日本語名。画面で管理用の名前の代わりに出す */
  app.get('/admin/departments', atLeast('dept_viewer'), (c) => {
    const admin = c.get('admin');
    const all = departments(admin.orgId);
    return c.json(admin.role === 'dept_viewer' ? all.filter((d) => d.code === admin.department) : all);
  });
}
