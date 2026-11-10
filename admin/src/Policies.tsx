import { useEffect, useMemo, useState } from 'react';
import { ALL_CATEGORIES, CATEGORY_INFO } from '../../src/core/model/categories';
import type { Category } from '../../src/core/model/types';
import { SAFE_TOKEN } from '../../shared/usage-event';
import { PolicySchema, type Policy } from '../../src/core/policy';
import { api, ApiError, type PolicyVersion } from './api';
import { AI_SITES } from './labels';

// 組織ポリシーの編集（SERVER_DESIGN.md §6）。拡張と同じ PolicySchema で検証し、版として保存して MDM 用に書き出す。

type Restriction = 'none' | 'locked' | 'prohibited';

type Form = {
  version: string;
  name: string;
  contact: string;
  expiresOn: string;
  minStage: 'A' | 'B';
  useNer: boolean;
  useNano: boolean;
  limitSites: boolean;
  sites: string[];
  restrictions: Partial<Record<Category, Restriction>>;
  requireConditions: boolean;
  reporting: boolean;
  endpoint: string;
  orgToken: string;
  department: string;
};

const EDITABLE = ALL_CATEGORIES.filter((c) => c !== 'credential'); // 認証情報は常に解除できない

const emptyForm = (): Form => ({
  version: '', name: '', contact: '', expiresOn: '', minStage: 'A', useNer: false, useNano: false,
  limitSites: false, sites: AI_SITES.map((s) => s.origin), restrictions: {},
  requireConditions: false, reporting: true, endpoint: window.location.origin, orgToken: '', department: '',
});

function toForm(p: Policy): Form {
  const restrictions: Form['restrictions'] = {};
  for (const c of p.lockedCategories ?? []) restrictions[c] = 'locked';
  for (const c of p.prohibitedCategories ?? []) restrictions[c] = 'prohibited';
  return {
    version: '', // 保存した版は変えられないので、新しい版の名前を付け直す
    name: p.name ?? '', contact: p.contact ?? '', expiresOn: p.expiresAt?.slice(0, 10) ?? '',
    minStage: p.minStage ?? 'A', useNer: p.minProfile?.includes('ner') ?? false, useNano: p.minProfile?.includes('nano') ?? false,
    limitSites: p.allowedOrigins !== undefined, sites: p.allowedOrigins ?? AI_SITES.map((s) => s.origin), restrictions,
    requireConditions: p.requireConditions ?? false,
    reporting: p.reporting?.enabled ?? false, endpoint: p.reporting?.endpoint ?? window.location.origin,
    orgToken: p.reporting?.orgToken ?? '', department: p.reporting?.department ?? '',
  };
}

function toPolicy(f: Form): unknown {
  const of = (r: Restriction) => EDITABLE.filter((c) => f.restrictions[c] === r);
  return {
    version: f.version.trim(),
    ...(f.name.trim() ? { name: f.name.trim() } : {}),
    ...(f.contact.trim() ? { contact: f.contact.trim() } : {}),
    // 有効期限はその日の終わり（UTC）まで
    ...(f.expiresOn ? { expiresAt: `${f.expiresOn}T23:59:59.999Z` } : {}),
    minStage: f.minStage,
    minProfile: ['rule', ...(f.useNer ? ['ner'] : []), ...(f.useNano ? ['nano'] : [])],
    ...(f.limitSites ? { allowedOrigins: f.sites } : {}),
    ...(of('prohibited').length ? { prohibitedCategories: of('prohibited') } : {}),
    ...(of('locked').length ? { lockedCategories: of('locked') } : {}),
    requireConditions: f.requireConditions,
    ...(f.reporting ? { reporting: { enabled: true, endpoint: f.endpoint.trim(), orgToken: f.orgToken.trim(), ...(f.department.trim() ? { department: f.department.trim() } : {}) } } : {}),
  };
}

const PATH_LABEL: Record<string, string> = {
  version: '版', minStage: '最低段階', expiresAt: '有効期限',
  'reporting.endpoint': '記録の送信先', 'reporting.orgToken': '組織トークン', 'reporting.department': '部署',
};

export function Policies() {
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [form, setForm] = useState<Form>(emptyForm);
  const [saved, setSaved] = useState<{ id: number; version: string } | null>(null);
  const [serverIssues, setServerIssues] = useState<{ path: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => { setForm((f) => ({ ...f, [key]: value })); setSaved(null); setServerIssues([]); };

  const refresh = () => api.policies().then(setVersions).catch(() => setVersions([]));
  useEffect(() => { void refresh(); }, []);

  const candidate = useMemo(() => toPolicy(form), [form]);
  const check = PolicySchema.strict().safeParse(candidate);
  const issues = [
    ...(check.success ? [] : check.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))),
    ...(form.version && !SAFE_TOKEN.test(form.version.trim()) ? [{ path: 'version', message: '英数字と . _ - だけで、32文字までにしてください（利用記録の集計に使うため）' }] : []),
    ...serverIssues,
  ];

  async function load(id: number) {
    const { policy } = await api.policy(id);
    setForm(toForm(policy));
    setSaved(null);
    setServerIssues([]);
  }

  async function save() {
    if (!check.success || issues.length) return;
    setBusy(true);
    try {
      setSaved(await api.savePolicy(check.data));
      await refresh();
    } catch (e) {
      setServerIssues(e instanceof ApiError && e.issues.length ? e.issues : [{ path: '', message: '保存できませんでした。' }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="policies" aria-labelledby="policies-title">
      <aside className="versions" aria-label="保存した版">
        <h2>保存した版</h2>
        {versions.length === 0 ? <p className="empty">まだありません。</p> : (
          <ul>
            {versions.map((v) => (
              <li key={v.id}>
                <span className="version-name">{v.version}</span>
                <span className="version-meta">{v.createdAt.slice(0, 10)} {v.createdBy}</span>
                <button type="button" className="ghost" onClick={() => void load(v.id)}>この版をもとに編集</button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <form className="card policy-form" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-labelledby="policies-title">
        <h1 id="policies-title">組織ポリシー</h1>
        <p className="hint">保存した版は変更できません。編集すると新しい版になります。部署ごとに値を変えるときは、部署ごとに版を作り、MDM の配布先を分けてください。</p>

        <fieldset>
          <legend>基本</legend>
          <label className="field"><span>版（英数字と . _ -）</span><input value={form.version} onChange={(e) => set('version', e.target.value)} placeholder="例 2026-11" required /></label>
          <label className="field"><span>名前（社員の画面に表示）</span><input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="顧客対応部の AI 利用ルール" /></label>
          <label className="field"><span>相談先</span><input value={form.contact} onChange={(e) => set('contact', e.target.value)} placeholder="情報システム部 内線 1234" /></label>
          <label className="field"><span>有効期限（過ぎると出力を止める）</span><input type="date" value={form.expiresOn} onChange={(e) => set('expiresOn', e.target.value)} /></label>
        </fieldset>

        <fieldset>
          <legend>加工の強さ</legend>
          <div className="radio-row" role="radiogroup" aria-label="最低段階">
            {(['A', 'B'] as const).map((s) => (
              <label key={s}><input type="radio" name="minStage" checked={form.minStage === s} onChange={() => set('minStage', s)} />{s === 'A' ? 'A 以上（識別情報を優先）' : 'B 以上（属性も一般化）'}</label>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={form.useNer} onChange={(e) => set('useNer', e.target.checked)} />NER（人名・組織・地名の検出）を必ず使う</label>
          <label className="check"><input type="checkbox" checked={form.useNano} onChange={(e) => set('useNano', e.target.checked)} />Gemini Nano（文脈の補助判定）を必ず使う</label>
          <label className="check"><input type="checkbox" checked={form.requireConditions} onChange={(e) => set('requireConditions', e.target.checked)} />利用条件の確認が済むまで出力させない</label>
        </fieldset>

        <fieldset>
          <legend>貼り付けてよい AI サイト</legend>
          <label className="check"><input type="checkbox" checked={form.limitSites} onChange={(e) => set('limitSites', e.target.checked)} />選んだサイトだけに挿入を許す</label>
          {form.limitSites && (
            <div className="radio-row">
              {AI_SITES.map((s) => (
                <label key={s.origin}>
                  <input type="checkbox" checked={form.sites.includes(s.origin)} onChange={(e) => set('sites', e.target.checked ? [...form.sites, s.origin] : form.sites.filter((o) => o !== s.origin))} />
                  {s.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>情報の種類ごとの扱い</legend>
          <p className="hint">「解除できない」は社員がそのまま残す操作をできなくします。「残してはいけない」は残っていると出力を止めます。認証情報は常に解除できません。</p>
          <div className="restrictions">
            {EDITABLE.map((c) => (
              <label key={c} className="restriction">
                <span>{CATEGORY_INFO[c].label}</span>
                <select value={form.restrictions[c] ?? 'none'} onChange={(e) => set('restrictions', { ...form.restrictions, [c]: e.target.value as Restriction })}>
                  <option value="none">制限なし</option>
                  <option value="locked">解除できない</option>
                  <option value="prohibited">残してはいけない</option>
                </select>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>利用記録の送信</legend>
          <label className="check"><input type="checkbox" checked={form.reporting} onChange={(e) => set('reporting', e.target.checked)} />文章を含まない利用記録をこのサーバーへ送らせる</label>
          {form.reporting && (
            <>
              <label className="field"><span>送信先</span><input value={form.endpoint} onChange={(e) => set('endpoint', e.target.value)} /></label>
              <label className="field"><span>組織トークン（「トークン」の画面で発行したもの）</span><input value={form.orgToken} onChange={(e) => set('orgToken', e.target.value)} placeholder="tc_…" spellCheck={false} /></label>
              <label className="field"><span>部署（英数字と . _ -。部署別の集計に使う）</span><input value={form.department} onChange={(e) => set('department', e.target.value)} placeholder="sales" /></label>
            </>
          )}
        </fieldset>

        {issues.length > 0 && form.version && (
          <div className="banner danger" role="alert">
            <strong>保存する前に直してください</strong>
            <ul>{issues.map((i) => <li key={`${i.path}:${i.message}`}>{PATH_LABEL[i.path] ? `${PATH_LABEL[i.path]}: ` : ''}{i.message}</li>)}</ul>
          </div>
        )}

        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || !form.version || issues.length > 0}>この内容で新しい版を保存</button>
          {saved && (
            <>
              <span className="saved" role="status">版 {saved.version} を保存しました</span>
              <a className="button" href={api.exportUrl(saved.id, 'google')} download>Google 管理コンソール用 JSON</a>
              <a className="button" href={api.exportUrl(saved.id, 'raw')} download>そのままの JSON</a>
            </>
          )}
        </div>
      </form>
    </section>
  );
}
