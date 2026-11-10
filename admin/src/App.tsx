import { useEffect, useState } from 'react';
import { Admins } from './Admins';
import { api, ApiError, atLeast, type Me, type Role } from './api';
import { Assignments } from './Assignments';
import { Audit } from './Audit';
import { CoveragePage } from './Coverage';
import { Overview } from './Overview';
import { Policies } from './Policies';
import { Tokens } from './Tokens';

type Page = 'overview' | 'coverage' | 'policies' | 'assignments' | 'tokens' | 'admins' | 'audit';
/** 役割ごとに見せる画面。サーバー側でも同じ役割で API を守る */
const PAGES: { id: Page; label: string; min: Role }[] = [
  { id: 'overview', label: '概要', min: 'dept_viewer' },
  { id: 'coverage', label: '適用状況', min: 'dept_viewer' },
  { id: 'policies', label: 'ポリシー', min: 'policy_admin' },
  { id: 'assignments', label: '配布', min: 'viewer' },
  { id: 'tokens', label: '登録トークン', min: 'policy_admin' },
  { id: 'admins', label: '管理者', min: 'owner' },
  { id: 'audit', label: '変更履歴', min: 'viewer' },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('overview');
  useEffect(() => { api.me().then(setMe).catch(() => setMe(null)); }, []);

  if (me === undefined) return null;
  if (me === null) return <Login onDone={setMe} />;
  const pages = PAGES.filter((p) => atLeast(me, p.min));
  return (
    <div className="shell">
      <header className="topbar">
        <div className="org">
          <span className="product">テキストクリーナー 管理</span>
          <span className="org-name">{me.organization}</span>
        </div>
        <nav aria-label="管理画面">
          {pages.map((p) => (
            <button key={p.id} type="button" aria-current={page === p.id ? 'page' : undefined} onClick={() => setPage(p.id)}>{p.label}</button>
          ))}
        </nav>
        <div className="account">
          <span>{me.email}</span>
          <span className="role-badge">{me.role}{me.department ? `・${me.department}` : ''}</span>
          <button type="button" className="ghost" onClick={() => void api.logout().then(() => setMe(null))}>ログアウト</button>
        </div>
      </header>
      <main>
        {page === 'overview' && <Overview fixedDepartment={me.role === 'dept_viewer' ? me.department : null} />}
        {page === 'coverage' && <CoveragePage fixedDepartment={me.role === 'dept_viewer' ? me.department : null} />}
        {page === 'policies' && atLeast(me, 'policy_admin') && <Policies />}
        {page === 'assignments' && atLeast(me, 'viewer') && <Assignments canEdit={atLeast(me, 'policy_admin')} />}
        {page === 'tokens' && atLeast(me, 'policy_admin') && <Tokens />}
        {page === 'admins' && atLeast(me, 'owner') && <Admins me={me} />}
        {page === 'audit' && atLeast(me, 'viewer') && <Audit />}
      </main>
      <footer className="privacy-note">この画面に届くのは、文章を含まない利用記録（種類ごとの件数・出力先・時刻は1時間単位）と、端末ごとのポリシーの版と状態（日付単位、台数の集計だけ）です。</footer>
    </div>
  );
}

function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setError(null);
    try {
      await api.login(email, password);
      onDone(await api.me());
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? 'ログインの失敗が続いたため、15分ほど待ってからお試しください。' : 'メールアドレスかパスワードが違います。');
    }
  }
  return (
    <main className="login">
      <form className="card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h1>テキストクリーナー 管理</h1>
        <label className="field"><span>メールアドレス</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field"><span>パスワード</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="banner danger" role="alert">{error}</p>}
        <button type="submit" className="primary">ログイン</button>
      </form>
    </main>
  );
}
