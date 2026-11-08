import { useEffect, useState } from 'react';
import { api, type Token } from './api';

// 組織トークン。拡張がこのサーバーへ記録を書き込むためだけの鍵。平文は発行したときに1回だけ表示する。

export function Tokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = () => api.tokens().then(setTokens).catch(() => setTokens([]));
  useEffect(() => { void refresh(); }, []);

  async function create() {
    const created = await api.createToken(label.trim());
    setIssued(created);
    setCopied(false);
    setLabel('');
    await refresh();
  }

  async function revoke(id: number) {
    await api.revokeToken(id);
    setConfirming(null);
    await refresh();
  }

  return (
    <section className="tokens" aria-labelledby="tokens-title">
      <div className="card">
        <h1 id="tokens-title">組織トークン</h1>
        <p className="hint">拡張は組織ポリシーに書いたトークンで記録を送ります。トークンでできるのは記録の書き込みだけで、集計やポリシーは読めません。</p>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (label.trim()) void create(); }}>
          <label className="field"><span>用途の名前</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="営業部の配布用" maxLength={40} /></label>
          <button type="submit" className="primary" disabled={!label.trim()}>発行する</button>
        </form>
        {issued && (
          <div className="issued" role="status">
            <p><strong>「{issued.label}」のトークンです。</strong>この画面を離れると二度と表示できません。ポリシーの「組織トークン」に貼り付けてください。</p>
            <div className="token-row">
              <code>{issued.token}</code>
              <button type="button" onClick={() => void navigator.clipboard.writeText(issued.token).then(() => setCopied(true))}>{copied ? 'コピーしました' : 'コピー'}</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>発行したトークン</h2>
        {tokens.length === 0 ? <p className="empty">まだありません。</p> : (
          <table className="data-table">
            <thead><tr><th scope="col">用途</th><th scope="col">発行日</th><th scope="col">状態</th><th scope="col"><span className="visually-hidden">操作</span></th></tr></thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.label}</td>
                  <td>{t.createdAt.slice(0, 10)}</td>
                  <td>{t.revokedAt ? `失効（${t.revokedAt.slice(0, 10)}）` : '有効'}</td>
                  <td className="row-action">
                    {!t.revokedAt && (confirming === t.id ? (
                      <>
                        <span>このトークンの記録を受け付けなくなります。</span>
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
