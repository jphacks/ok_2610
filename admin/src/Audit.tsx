import { useEffect, useState } from 'react';
import { api, type AuditEntry } from './api';
import { AUDIT_LABEL, deptLabel } from './labels';

// 変更履歴（SEC-04）。誰が・いつ・何を変えたかを、新しい順に見せる。トークンの平文やパスワードは記録していない。

function describe(e: AuditEntry): string {
  const d = e.detail;
  const dept = 'department' in d ? deptLabel(d.department as string | null) : null;
  switch (e.action) {
    case 'policy.create': return `版 ${String(d.version)}`;
    case 'assignment.publish': return `${dept} に版 ${String(d.version)}${d.minExtensionVersion ? `（拡張 ${String(d.minExtensionVersion)} 以上）` : ''}`;
    case 'assignment.remove': return `${dept}`;
    case 'token.create': return `「${String(d.label)}」（${dept}）`;
    case 'token.revoke': return `「${String(d.label)}」`;
    case 'admin.create':
    case 'admin.update': return `${String(d.email)} を ${String(d.role)}${d.department ? `（${String(d.department)}）` : ''}`;
    case 'admin.disable': return String(d.email);
    default: return JSON.stringify(d);
  }
}

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => { void api.audit().then(setEntries).catch(() => setEntries([])); }, []);
  return (
    <section aria-labelledby="audit-title">
      <div className="card">
        <h1 id="audit-title">変更履歴</h1>
        <p className="hint">ポリシーの保存と配布、登録トークン、管理者の変更を記録しています。新しい順に200件まで表示します。</p>
        {entries === null ? null : entries.length === 0 ? <p className="empty">まだ変更はありません。</p> : (
          <table className="data-table">
            <thead><tr><th scope="col">日時（UTC）</th><th scope="col">変更した人</th><th scope="col">変更</th><th scope="col">内容</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{e.at.slice(0, 16).replace('T', ' ')}</td>
                  <td>{e.adminEmail}</td>
                  <td>{AUDIT_LABEL[e.action] ?? e.action}</td>
                  <td>{describe(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
