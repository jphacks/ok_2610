import { useEffect, useState } from 'react';
import type { PolicyState } from '../../shared/management';
import { api, type Coverage } from './api';
import { deptLabel, POLICY_STATE_LABEL } from './labels';

// 適用状況（SERVER_DESIGN.md §12-5）。配った版が端末に届いているかを、部署・版ごとの台数で見せる。端末ごとの一覧は出さない。

const fmt = (n: number) => n.toLocaleString('ja-JP');
const STOPPED: PolicyState[] = ['expired', 'missing', 'invalid', 'outdated'];

export function CoveragePage({ fixedDepartment }: { fixedDepartment: string | null }) {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.coverage(fixedDepartment ?? undefined)
      .then((c) => { if (live) { setCoverage(c); setError(null); } })
      .catch(() => { if (live) setError('適用状況を読み込めませんでした。'); });
    return () => { live = false; };
  }, [fixedDepartment]);

  if (error) return <p className="banner danger" role="alert">{error}</p>;
  if (!coverage) return null;
  const { totals } = coverage;
  const rate = totals.devices ? Math.round((totals.current / totals.devices) * 100) : 0;

  return (
    <section aria-labelledby="coverage-title">
      <div className="filters">
        <h1 id="coverage-title" className="page-title">適用状況</h1>
        <span className="period">{coverage.from} 〜 {coverage.to} に報告した端末{fixedDepartment ? `（部署 ${fixedDepartment}）` : ''}</span>
      </div>

      <div className="dashboard">
        <div className="tiles">
          <div className="tile hero">
            <span className="tile-label">配った版を適用している端末</span>
            <span className="tile-value">{fmt(totals.current)}<small> / {fmt(totals.devices)} 台</small></span>
            <span className="tile-label">{totals.devices ? `${rate}%` : 'まだ報告がありません'}</span>
          </div>
          <div className={`tile ${totals.stopped ? 'tile-alert' : ''}`}>
            <span className="tile-label">ポリシーを使えず出力が止まっている端末</span>
            <span className="tile-value">{fmt(totals.stopped)}<small> 台</small></span>
          </div>
        </div>

        <div className="card wide">
          <h2>部署ごと</h2>
          {coverage.departments.length === 0 ? (
            <p className="empty">まだ端末からの報告がありません。登録トークンの初期設定を MDM で配り、社員がサイドパネルを開くと、1日1回まで報告が届きます。</p>
          ) : (
            <div className="table-view">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">部署</th>
                    <th scope="col">配っている版</th>
                    <th scope="col" className="num">端末</th>
                    <th scope="col" className="num">配った版を適用</th>
                    {STOPPED.map((s) => <th key={s} scope="col" className="num">{POLICY_STATE_LABEL[s]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {coverage.departments.map((d) => (
                    <tr key={d.department ?? ''}>
                      <td>{deptLabel(d.department)}</td>
                      <td>{d.assignedVersion ?? <span className="muted">配っていない</span>}</td>
                      <td className="num">{fmt(d.devices)}</td>
                      <td className="num">{fmt(d.current)}{d.devices > 0 && d.current < d.devices && <span className="muted">（残り {fmt(d.devices - d.current)}）</span>}</td>
                      {STOPPED.map((s) => <td key={s} className={`num ${d.states[s] ? 'attention' : ''}`}>{fmt(d.states[s])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">「配った版を適用」に入らない端末は、まだ新しい版を受け取っていないか（サイドパネルを開くと受け取る）、上の理由で止まっています。MDM で直接配っている端末は、版が一致すれば適用に数えます。</p>
        </div>

        {coverage.extensionVersions.length > 0 && (
          <div className="card">
            <h2>拡張の版</h2>
            <table className="data-table">
              <thead><tr><th scope="col">版</th><th scope="col" className="num">端末</th></tr></thead>
              <tbody>{coverage.extensionVersions.map((v) => <tr key={v.version}><td>{v.version}</td><td className="num">{fmt(v.count)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
