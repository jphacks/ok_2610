import { useState } from 'react';

// 管理画面のグラフ。どれも1系列なので凡例は置かず、見出しが何の数かを示す。
// 値は棒の先に書き、日ごとの棒は表でも読めるようにする（ツールチップだけに頼らない）。

const fmt = (n: number) => n.toLocaleString('ja-JP');

/** 横棒（種類・出力先・理由などの比較）。値は棒の先に置く */
export function HBars({ rows, label }: { rows: { key: string; name: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="empty">この期間の記録はありません。</p>;
  return (
    <ul className="hbars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key}>
          <span className="hbar-name">{r.name}</span>
          <span className="hbar-track">
            <span className="hbar" style={{ width: `${(r.value / max) * 100}%` }} />
            <span className="hbar-value">{fmt(r.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 日ごとの縦棒。棒ごとに hover / focus で値を出し、同じ値を表でも見られる */
export function DailyColumns({ rows, label }: { rows: { date: string; value: number }[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  if (!rows.length) return <p className="empty">この期間の記録はありません。</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const top = niceMax(max);
  const shown = active === null ? null : rows[active];
  return (
    <figure className="columns-figure">
      <div className="columns" role="list" aria-label={label} onPointerLeave={() => setActive(null)}>
        <div className="columns-axis" aria-hidden="true">
          <span>{fmt(top)}</span>
          <span>{fmt(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="columns-plot">
          {rows.map((r, i) => (
            <button
              type="button"
              role="listitem"
              key={r.date}
              className={`column-hit ${active === i ? 'on' : ''}`}
              aria-label={`${shortDate(r.date)} ${fmt(r.value)}回`}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              <span className="column" style={{ height: `${(r.value / top) * 100}%` }} />
            </button>
          ))}
        </div>
      </div>
      <div className="columns-x" aria-hidden="true">
        <span>{shortDate(rows[0]!.date)}</span>
        <span>{shortDate(rows.at(-1)!.date)}</span>
      </div>
      <p className="readout" aria-live="polite">
        {shown ? (
          <>
            <strong>{fmt(shown.value)}回</strong> {shortDate(shown.date)}
          </>
        ) : (
          '棒にカーソルを合わせると日ごとの回数を表示します'
        )}
      </p>
      <details className="table-view">
        <summary>表で見る</summary>
        <table>
          <thead>
            <tr><th scope="col">日付</th><th scope="col">回数</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date}><td>{r.date}</td><td>{fmt(r.value)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function niceMax(n: number): number {
  const step = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) if (m * step >= n) return m * step;
  return 10 * step;
}

const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 期間の日付をすべて並べ、記録のない日は 0 にする（棒の間隔を日付どおりにする） */
export function fillDays(from: string, to: string, rows: { date: string; outputs: number }[]): { date: string; value: number }[] {
  const byDate = new Map(rows.map((r) => [r.date, r.outputs]));
  const out: { date: string; value: number }[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: byDate.get(key) ?? 0 });
  }
  return out;
}
