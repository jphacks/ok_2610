import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { Overview } from './Overview';
import { Policies } from './Policies';
import { Tokens } from './Tokens';

type Page = 'overview' | 'policies' | 'tokens';
const PAGES: { id: Page; label: string }[] = [
  { id: 'overview', label: '概要' },
  { id: 'policies', label: 'ポリシー' },
  { id: 'tokens', label: 'トークン' },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('overview');
  useEffect(() => { api.me().then(setMe).catch(() => setMe(null)); }, []);

  if (me === undefined) return null;
  if (me === null) return <Login onDone={setMe} />;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="org">
          <span className="product">テキストクリーナー 管理</span>
          <span className="org-name">{me.organization}</span>
        </div>
        <nav aria-label="管理画面">
          {PAGES.map((p) => (
            <button key={p.id} type="button" aria-current={page === p.id ? 'page' : undefined} onClick={() => setPage(p.id)}>{p.label}</button>
          ))}
        </nav>
        <div className="account">
          <span>{me.email}</span>
          <button type="button" className="ghost" onClick={() => void api.logout().then(() => setMe(null))}>ログアウト</button>
        </div>
      </header>
      <main>
        {page === 'overview' && <Overview />}
        {page === 'policies' && <Policies />}
        {page === 'tokens' && <Tokens />}
      </main>
      <footer className="privacy-note">この画面に届くのは、文章を含まない利用記録（種類ごとの件数・出力先・時刻は1時間単位）だけです。</footer>
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
