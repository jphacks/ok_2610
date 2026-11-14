import { useEffect, useState } from 'react';
import { api, ApiError, type Assignment, type PolicyVersion, type Token } from './api';
import { deptLabel } from './labels';

// 配布（SERVER_DESIGN.md §12-2）。部署ごとに配る版を決める。部署の割り当てがない端末には全社の既定を配る。
// 端末は次にサイドパネルを開いたときに新しい版を受け取る。
// 開発者モードをオンにすると、取り下げ・失効した端末は次の問い合わせで組織の管理から外れ、個人設定で動く（§12-8）。

const SEMVER = /^\d+\.\d+\.\d+$/;
const SAFE = /^[A-Za-z0-9._-]{1,32}$/;

export function Assignments({ canEdit }: { canEdit: boolean }) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [department, setDepartment] = useState('');
  const [policyId, setPolicyId] = useState<number | ''>('');
  const [minVersion, setMinVersion] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [developerMode, setDeveloperMode] = useState<boolean | null>(null);
  const [savingMode, setSavingMode] = useState(false);

  const refresh = () => api.assignments().then(setAssignments).catch(() => setAssignments([]));
  useEffect(() => {
    void refresh();
    void api.policies().then(setVersions).catch(() => setVersions([]));
    void api.settings().then((s) => setDeveloperMode(s.developerMode)).catch(() => setDeveloperMode(null));
    // 部署の候補は、発行した登録トークンの部署から取る（policy_admin だけが読める）
    if (canEdit) void api.tokens().then((ts: Token[]) => setDepartments([...new Set(ts.filter((t) => !t.revokedAt && t.department).map((t) => t.department!))])).catch(() => undefined);
  }, [canEdit]);

  const dept = department.trim();
  const problems = [
    ...(dept && !SAFE.test(dept) ? ['部署は英数字と . _ - だけで、32文字までにしてください'] : []),
    ...(minVersion.trim() && !SEMVER.test(minVersion.trim()) ? ['拡張の最低版は 0.10.0 の形で書いてください'] : []),
  ];

  async function publish() {
    if (policyId === '' || problems.length) return;
    setMessage(null);
    try {
      await api.assign({ department: dept || null, policyId, minExtensionVersion: minVersion.trim() || null });
      const v = versions.find((x) => x.id === policyId)?.version;
      setMessage({ tone: 'ok', text: `${deptLabel(dept || null)}に版 ${v} を配りました。端末は次にサイドパネルを開いたときに受け取ります。` });
      setDepartment('');
      setMinVersion('');
      await refresh();
    } catch (e) {
      setMessage({ tone: 'danger', text: e instanceof ApiError && e.issues[0] ? e.issues[0].message : '配布できませんでした。' });
    }
  }

  async function toggleMode(next: boolean) {
    setSavingMode(true);
    try {
      await api.saveSettings({ developerMode: next });
      setDeveloperMode(next);
    } catch {
      setMessage({ tone: 'danger', text: '開発者モードを切り替えられませんでした。' });
    } finally {
      setSavingMode(false);
    }
  }

  async function unassign(d: string | null) {
    await api.unassign(d);
    setConfirming(null);
    await refresh();
  }

  return (
    <section className="tokens" aria-labelledby="assignments-title">
      {canEdit && (
        <div className="card">
          <h1 id="assignments-title">ポリシーの配布</h1>
          <p className="hint">登録トークンの部署ごとに、配る版を決めます。部署を空にすると全社の既定になり、部署の割り当てがない端末に届きます。署名付きで配るので、端末の中で書き換えられても受け取りません。</p>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void publish(); }}>
            <label className="field"><span>部署（空なら全社の既定）</span>
              <input value={department} onChange={(e) => setDepartment(e.target.value)} list="known-departments" placeholder="sales" maxLength={32} />
              <datalist id="known-departments">{departments.map((d) => <option key={d} value={d} />)}</datalist>
            </label>
            <label className="field"><span>配る版</span>
              <select value={policyId} onChange={(e) => setPolicyId(e.target.value ? Number(e.target.value) : '')} required>
                <option value="">選んでください</option>
                {versions.map((v) => <option key={v.id} value={v.id}>{v.version}（{v.createdAt.slice(0, 10)}）</option>)}
              </select>
            </label>
            <label className="field"><span>拡張の最低版（任意。これより古い拡張は出力を止める）</span>
              <input value={minVersion} onChange={(e) => setMinVersion(e.target.value)} placeholder="0.10.0" maxLength={20} />
            </label>
            <button type="submit" className="primary" disabled={policyId === '' || problems.length > 0}>配布する</button>
          </form>
          {problems.length > 0 && <ul className="banner danger" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          {message && <p className={`banner ${message.tone === 'danger' ? 'danger' : ''}`} role="status">{message.text}</p>}
        </div>
      )}

      <div className="card">
        <h2 id={canEdit ? undefined : 'assignments-title'}>配っている版</h2>
        {assignments.length === 0 ? <p className="empty">まだ配っていません。サーバーから受け取る設定の端末は、ポリシーを受け取れず出力を止めます。</p> : (
          <table className="data-table">
            <thead><tr><th scope="col">部署</th><th scope="col">版</th><th scope="col">拡張の最低版</th><th scope="col">配布日</th><th scope="col">配布した人</th>{canEdit && <th scope="col"><span className="visually-hidden">操作</span></th>}</tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.department ?? ''}>
                  <td>{deptLabel(a.department)}{a.department === null && <span className="muted">（既定）</span>}</td>
                  <td>{a.version}</td>
                  <td>{a.minExtensionVersion ?? <span className="muted">指定なし</span>}</td>
                  <td>{a.publishedAt.slice(0, 10)}</td>
                  <td>{a.publishedBy}</td>
                  {canEdit && (
                    <td className="row-action">
                      {confirming === (a.department ?? '') ? (
                        <>
                          <span>{a.department !== null ? 'この部署には全社の既定が届くようになります。'
                            : developerMode ? '部署の割り当てがない端末は、次にサイドパネルを開いたときに組織の管理から外れ、個人設定で動きます。' : '部署の割り当てがない端末は、ポリシーを受け取れなくなります。'}</span>
                          <button type="button" onClick={() => setConfirming(null)}>キャンセル</button>
                          <button type="button" className="danger" onClick={() => void unassign(a.department)}>取り下げる</button>
                        </>
                      ) : (
                        <button type="button" className="ghost" onClick={() => setConfirming(a.department ?? '')}>取り下げ…</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">{developerMode
          ? '開発者モードがオンなので、配る版がなくなった端末は、次にサイドパネルを開いたときに組織の管理から外れ、個人設定で動きます。'
          : '取り下げても、端末に保存済みの版は、受け取ってから最長8日のあいだ使われます。'}</p>
      </div>

      {developerMode !== null && (
        <div className="card">
          <h2>開発者モード（試す・開発向け）</h2>
          <p className="hint">ふだんは、配布を取り下げたり登録トークンを失効したりしても、端末は保存済みの版を最長8日のあいだ使い続け、そのあと出力を止めます（組織の管理下の端末を、個人設定に弱めないため）。オンにすると、その端末は次にサイドパネルを開いてサーバーに問い合わせたときに、署名付きの知らせを受け取って<strong>組織の管理から外れ、すぐに個人設定で動きます</strong>。通信できないだけのときは、今までどおり保存済みの版で動きます。</p>
          {canEdit ? (
            <label className="check">
              <input type="checkbox" checked={developerMode} disabled={savingMode} onChange={(e) => void toggleMode(e.target.checked)} />
              取り下げ・失効したら、次の問い合わせですぐ個人設定に戻す
            </label>
          ) : (
            <p>{developerMode ? 'オン（取り下げ・失効した端末は次の問い合わせで個人設定に戻る）' : 'オフ（保存済みの版を最長8日使ってから止まる）'}</p>
          )}
          <p className="hint">本番の運用ではオフにしてください。個人設定に戻った端末は、配り直すか、新しい登録トークンを配ると、また組織の管理下に戻ります。</p>
        </div>
      )}
    </section>
  );
}
