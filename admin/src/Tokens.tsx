import { useEffect, useState } from 'react';
import { api, type IssuedToken, type Token } from './api';
import { deptLabel } from './labels';

// 登録トークン（SERVER_DESIGN.md §12-1）。部署ごとに発行し、MDM の初期設定に入れて社員の端末に配る。
// トークンでできるのは、その部署のポリシーを受け取ることと、利用記録・適用状況を書き込むことだけ。平文は発行したときに1回だけ表示する。

const SAFE = /^[A-Za-z0-9._-]{1,32}$/;

export function Tokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [label, setLabel] = useState('');
  const [department, setDepartment] = useState('');
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);

  const refresh = () => api.tokens().then(setTokens).catch(() => setTokens([]));
  useEffect(() => {
    void refresh();
    void api.settings().then((s) => setDeveloperMode(s.developerMode)).catch(() => undefined);
  }, []);

  const dept = department.trim();
  const badDept = dept !== '' && !SAFE.test(dept);

  async function create() {
    const created = await api.createToken(label.trim(), dept || null);
    setIssued(created);
    setCopied(null);
    setLabel('');
    setDepartment('');
    await refresh();
  }

  async function revoke(id: number) {
    await api.revokeToken(id);
    setConfirming(null);
    await refresh();
  }

  const copy = (key: string, text: string) => void navigator.clipboard.writeText(text).then(() => setCopied(key));

  return (
    <section className="tokens" aria-labelledby="tokens-title">
      <div className="card">
        <h1 id="tokens-title">登録トークン</h1>
        <p className="hint">部署ごとに発行し、MDM（Google 管理コンソールなど）で社員の端末に配ります。トークンでできるのは、その部署に配ったポリシーを受け取ることと、文章を含まない利用記録・適用状況を書き込むことだけです。集計やほかの部署のポリシーは読めません。</p>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (label.trim() && !badDept) void create(); }}>
          <label className="field"><span>用途の名前</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="営業部の配布用" maxLength={40} /></label>
          <label className="field"><span>部署（英数字と . _ -。空なら全社）</span><input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="sales" maxLength={32} /></label>
          <button type="submit" className="primary" disabled={!label.trim() || badDept}>発行する</button>
        </form>
        {badDept && <p className="banner danger" role="alert">部署は英数字と . _ - だけで、32文字までにしてください。</p>}
        {issued && (
          <div className="issued" role="status">
            <p><strong>「{issued.label}」（{deptLabel(issued.department)}）の登録トークンです。</strong>この画面を離れると二度と表示できません。</p>
            <div className="token-row">
              <code>{issued.token}</code>
              <button type="button" onClick={() => copy('token', issued.token)}>{copied === 'token' ? 'コピーしました' : 'コピー'}</button>
            </div>
            <p>MDM の拡張のポリシーに、次の初期設定を貼り付けてください。ポリシー本体は「配布」で選んだ版がサーバーから届きます。</p>
            <h3>Google 管理コンソール用</h3>
            <div className="token-row">
              <pre className="json-block">{JSON.stringify(issued.bootstrapGoogle, null, 2)}</pre>
              <button type="button" onClick={() => copy('google', JSON.stringify(issued.bootstrapGoogle, null, 2))}>{copied === 'google' ? 'コピーしました' : 'コピー'}</button>
            </div>
            <h3>そのままの JSON（ほかの MDM）</h3>
            <div className="token-row">
              <pre className="json-block">{JSON.stringify(issued.bootstrap, null, 2)}</pre>
              <button type="button" onClick={() => copy('raw', JSON.stringify(issued.bootstrap, null, 2))}>{copied === 'raw' ? 'コピーしました' : 'コピー'}</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>発行したトークン</h2>
        {tokens.length === 0 ? <p className="empty">まだありません。</p> : (
          <table className="data-table">
            <thead><tr><th scope="col">用途</th><th scope="col">部署</th><th scope="col">発行日</th><th scope="col">状態</th><th scope="col"><span className="visually-hidden">操作</span></th></tr></thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.label}</td>
                  <td>{deptLabel(t.department)}</td>
                  <td>{t.createdAt.slice(0, 10)}</td>
                  <td>{t.revokedAt ? `失効（${t.revokedAt.slice(0, 10)}）` : '有効'}</td>
                  <td className="row-action">
                    {!t.revokedAt && (confirming === t.id ? (
                      <>
                        <span>{developerMode
                          ? 'このトークンの端末は、次にサイドパネルを開いたときに組織の管理から外れ、個人設定で動きます（開発者モード）。'
                          : 'このトークンの端末は新しい版を受け取れず、記録も送れなくなります。保存済みの版は最長8日使われます。'}</span>
                        <button type="button" onClick={() => setConfirming(null)}>キャンセル</button>
                        <button type="button" className="danger" onClick={() => void revoke(t.id)}>失効する</button>
                      </>
                    ) : (
                      <button type="button" className="ghost" onClick={() => setConfirming(t.id)}>失効…</button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
