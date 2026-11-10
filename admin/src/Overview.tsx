import { useEffect, useState } from 'react';
import { api, type Stats } from './api';
import { DailyColumns, fillDays, HBars } from './charts';
import { BLOCKER_LABEL, categoryLabel, DESTINATION_LABEL, RISK_ORDER } from './labels';

const PERIODS = [
  { days: 7, label: '7日' },
  { days: 30, label: '30日' },
  { days: 90, label: '90日' },
];

const day = (offset: number) => new Date(Date.now() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString('ja-JP');

/** fixedDepartment: 担当部署だけを見る役割（dept_viewer）のとき、その部署に固定する */
export function Overview({ fixedDepartment }: { fixedDepartment: string | null }) {
  const [days, setDays] = useState(30);
  const [chosen, setDepartment] = useState('');
  const department = fixedDepartment ?? chosen;
  const [stats, setStats] = useState<Stats | null>(null);
  const [departments, setDepartments] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const from = day(days - 1);
  const to = day(0);
  // 表示中の集計がどの条件のものか。条件が変わってから届くまでは、前の数字を薄く残す
  const key = `${from}|${to}|${department}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== key;

  useEffect(() => {
    let live = true;
    api
      .stats({ from, to, ...(department ? { department } : {}) })
      .then((s) => {
        if (!live) return;
        setStats(s);
        setError(null);
        setLoadedKey(key);
        if (!department) setDepartments(s.departments.map((d) => d.department));
      })
      .catch(() => { if (live) { setError('集計を読み込めませんでした。'); setLoadedKey(key); } });
    return () => { live = false; };
  }, [from, to, department, key]);

  const maskedTotal = stats?.masked.reduce((a, r) => a + r.count, 0) ?? 0;
  const risky = stats?.riskLevels.find((r) => r.level === '要注意')?.count ?? 0;
  const assessed = stats?.riskLevels.reduce((a, r) => a + r.count, 0) ?? 0;

  return (
    <section aria-labelledby="overview-title">
      <h1 id="overview-title" className="visually-hidden">概要</h1>
      <div className="filters">
        <div className="segmented" role="group" aria-label="期間">
          {PERIODS.map((p) => (
            <button key={p.days} type="button" aria-pressed={days === p.days} onClick={() => setDays(p.days)}>{p.label}</button>
          ))}
        </div>
        {fixedDepartment ? <span className="period">部署 {fixedDepartment}</span> : (
        <label className="select">
          <span>部署</span>
          <select value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">すべて</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        )}
        <span className="period">{from} 〜 {to}</span>
      </div>

      {error && <p className="banner danger" role="alert">{error}</p>}
      {stats?.suppressed && (
        <p className="banner">この部署のこの期間の記録は5件未満のため、数字を表示していません。期間を広げてください。</p>
      )}

      {stats && !stats.suppressed && (
        <div className={`dashboard ${loading ? 'stale' : ''}`} aria-busy={loading}>
          <div className="tiles">
            <div className="tile hero">
              <span className="tile-label">AI に渡す前に加工して出力した回数</span>
              <span className="tile-value">{fmt(stats.totals.outputs)}</span>
            </div>
            <div className="tile">
              <span className="tile-label">加工した箇所</span>
              <span className="tile-value">{fmt(maskedTotal)}</span>
            </div>
            <div className="tile">
              <span className="tile-label">出力を止めた回数</span>
              <span className="tile-value">{fmt(stats.totals.blocked)}</span>
            </div>
            <div className="tile">
              <span className="tile-label">要注意で出力した割合</span>
              <span className="tile-value">{assessed ? `${Math.round((risky / assessed) * 100)}%` : '—'}</span>
            </div>
          </div>

          <article className="card wide">
            <h2>日ごとの出力回数</h2>
            <DailyColumns rows={fillDays(from, to, stats.daily)} label="日ごとの出力回数" />
          </article>

          <article className="card">
            <h2>加工した情報の種類</h2>
            <HBars label="加工した情報の種類" rows={stats.masked.slice(0, 8).map((r) => ({ key: r.category, name: categoryLabel(r.category), value: r.count }))} />
          </article>

          <article className="card">
            <h2>出力先</h2>
            <HBars label="出力先" rows={stats.byDestination.map((r) => ({ key: r.destination, name: DESTINATION_LABEL[r.destination] ?? r.destination, value: r.count }))} />
          </article>

          <article className="card">
            <h2>出力時の組合せリスク</h2>
            <HBars
              label="出力時の組合せリスク"
              rows={RISK_ORDER.flatMap((level) => {
                const count = stats.riskLevels.find((r) => r.level === level)?.count;
                return count ? [{ key: level, name: level, value: count }] : [];
              })}
            />
          </article>

          <article className="card">
            <h2>出力を止めた理由</h2>
            <HBars label="出力を止めた理由" rows={stats.blockers.map((r) => ({ key: r.kind, name: BLOCKER_LABEL[r.kind] ?? r.kind, value: r.count }))} />
          </article>

          {!department && stats.departments.length > 0 && (
            <article className="card wide">
              <h2>部署別の出力回数</h2>
              <table className="data-table">
                <thead><tr><th scope="col">部署</th><th scope="col">出力回数</th></tr></thead>
                <tbody>
                  {stats.departments.map((d) => (
                    <tr key={d.department}><td>{d.department}</td><td>{d.count === null ? '5件未満' : fmt(d.count)}</td></tr>
                  ))}
                </tbody>
              </table>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
