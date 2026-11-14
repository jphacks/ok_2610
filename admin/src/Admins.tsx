import { useEffect, useState } from 'react';
import { api, ApiError, type AdminAccount, type Me, type Role } from './api';
import { ROLE_LABEL } from './labels';

// 管理者（SERVER_DESIGN.md §12-6）。owner だけが使える。管理者は消さずに無効にし、変更履歴との結び付きを残す。

const ROLES: Role[] = ['owner', 'policy_admin', 'viewer', 'dept_viewer'];
const SAFE = /^[A-Za-z0-9._-]{1,32}$/;

const firstIssue = (e: unknown, fallback: string) => (e instanceof ApiError && e.issues[0] ? e.issues[0].message : fallback);

export function Admins({ me, onOrganizationDeleted }: { me: Me; onOrganizationDeleted: () => void }) {
  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [department, setDepartment] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  const refresh = () => api.admins().then(setAdmins).catch(() => setAdmins([]));
  useEffect(() => { void refresh(); }, []);

  const dept = department.trim();
  const problems = [
    ...(password && password.length < 12 ? ['パスワードは12文字以上にしてください'] : []),
    ...(role === 'dept_viewer' && !dept ? ['担当部署を指定してください'] : []),
    ...(dept && !SAFE.test(dept) ? ['部署は英数字と . _ - だけで、32文字までにしてください'] : []),
  ];

  async function create() {
    setMessage(null);
    try {
      await api.createAdmin({ email: email.trim(), password, role, department: role === 'dept_viewer' ? dept : null });
      setMessage({ tone: 'ok', text: `${email.trim()} を追加しました。パスワードは本人に別の手段で伝えてください。` });
      setEmail('');
      setPassword('');
      setDepartment('');
      await refresh();
    } catch (e) {
      setMessage({ tone: 'danger', text: firstIssue(e, '追加できませんでした。') });
    }
  }

  async function change(a: AdminAccount, next: Role) {
    setMessage(null);
    const nextDept = next === 'dept_viewer' ? a.department ?? window.prompt('担当部署（英数字と . _ -）を入力してください') ?? '' : null;
    if (next === 'dept_viewer' && !nextDept) return;
    try {
      await api.updateAdmin(a.id, { role: next, department: nextDept });
      await refresh();
    } catch (e) {
      setMessage({ tone: 'danger', text: firstIssue(e, '変更できませんでした。') });
    }
  }

  async function disable(id: number) {
    setMessage(null);
    try {
      await api.disableAdmin(id);
      setConfirming(null);
      await refresh();
    } catch (e) {
      setMessage({ tone: 'danger', text: firstIssue(e, '無効にできませんでした。') });
    }
  }

  return (
    <section className="tokens" aria-labelledby="admins-title">
      <div className="card">
        <h1 id="admins-title">管理者</h1>
        <p className="hint">役割ごとに使える画面と API が決まります。owner が1人もいなくなる変更はできません。</p>
        <ul className="role-list">{ROLES.map((r) => <li key={r}>{ROLE_LABEL[r]}</li>)}</ul>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (!problems.length) void create(); }}>
          <label className="field"><span>メールアドレス</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" /></label>
          <label className="field"><span>最初のパスワード（12文字以上）</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" /></label>
          <label className="field"><span>役割</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
          </label>
          {role === 'dept_viewer' && <label className="field"><span>担当部署</span><input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="sales" maxLength={32} /></label>}
          <button type="submit" className="primary" disabled={!email.trim() || !password || problems.length > 0}>追加する</button>
        </form>
        {problems.length > 0 && <ul className="banner danger" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {message && <p className={`banner ${message.tone === 'danger' ? 'danger' : ''}`} role="status">{message.text}</p>}
      </div>

      <div className="card">
        <h2>管理者の一覧</h2>
        <table className="data-table">
          <thead><tr><th scope="col">メールアドレス</th><th scope="col">役割</th><th scope="col">担当部署</th><th scope="col">状態</th><th scope="col"><span className="visually-hidden">操作</span></th></tr></thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.id}>
                <td>{a.email}{a.email === me.email && <span className="muted">（自分）</span>}</td>
                <td>
                  {a.disabledAt ? a.role : (
                    <select aria-label={`${a.email} の役割`} value={a.role} onChange={(e) => void change(a, e.target.value as Role)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  )}
                </td>
                <td>{a.department ?? <span className="muted">—</span>}</td>
                <td>{a.disabledAt ? `無効（${a.disabledAt.slice(0, 10)}）` : '有効'}</td>
                <td className="row-action">
                  {!a.disabledAt && a.email !== me.email && (confirming === a.id ? (
                    <>
                      <span>ログインできなくなり、ログイン中のセッションも切れます。</span>
                      <button type="button" onClick={() => setConfirming(null)}>キャンセル</button>
                      <button type="button" className="danger" onClick={() => void disable(a.id)}>無効にする</button>
                    </>
                  ) : (
                    <button type="button" className="ghost" onClick={() => setConfirming(a.id)}>無効にする…</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DeleteOrganization me={me} onDeleted={onOrganizationDeleted} />
    </section>
  );
}

/** 組織を消す（SERVER_DESIGN.md §15-1）。組織名とパスワードを入れ直してもらってから、すべてのデータを消す */
function DeleteOrganization({ me, onDeleted }: { me: Me; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api.deleteOrganization({ organizationName: name, password });
      onDeleted();
    } catch (e) {
      setError(firstIssue(e, '消せませんでした。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>組織を消す</h2>
      <p className="hint">組織「{me.organization}」と、そのすべてのデータ（管理者・ポリシー・配布・登録トークン・部署・利用記録・適用状況・変更履歴）を消します。元に戻せません。配った端末は登録トークンが使えなくなり、保存済みの版を使い終えると出力を止めます。</p>
      {!open ? (
        <button type="button" className="danger" onClick={() => setOpen(true)}>組織を消す…</button>
      ) : (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="field"><span>確かめのため、組織名「{me.organization}」を入れてください</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
          </label>
          <label className="field"><span>あなたのパスワード</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button type="button" onClick={() => { setOpen(false); setName(''); setPassword(''); setError(null); }}>キャンセル</button>
          <button type="submit" className="danger" disabled={busy || name.trim() !== me.organization || !password}>すべて消す</button>
        </form>
      )}
      {error && <p className="banner danger" role="alert">{error}</p>}
    </div>
  );
}
