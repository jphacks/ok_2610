import { useStore } from '../store';

const ENGINE_NAME = { rule: '規則', ner: 'NER', nano: 'Gemini Nano' } as const;

/** 出力を止める理由・再検査・手動操作の衝突・エンジンと検査範囲の状態（SF-02, FR-21） */
export function IssuesPanel() {
  const result = useStore((s) => s.result);
  const ops = useStore((s) => s.ops);
  const undo = useStore((s) => s.undo);
  const redoOp = useStore((s) => s.redoOp);
  const redo = useStore((s) => s.redo);
  if (!result) return null;
  const nonBlockingRecheck = result.recheck.filter((f) => !f.blocking);

  return (
    <div className="card">
      <div className="row between">
        <h3>確認事項</h3>
        <div className="row">
          <button type="button" className="ghost" onClick={undo} disabled={ops.length === 0}>
            操作を元に戻す
          </button>
          <button type="button" className="ghost" onClick={redoOp} disabled={redo.length === 0}>
            操作をやり直す
          </button>
        </div>
      </div>
      {result.blockers.length > 0 && (
        <div className="callout danger" role="alert">
          <strong>出力を止めています</strong>
          <ul>
            {result.blockers.map((b) => (
              <li key={b.message}>{b.message}</li>
            ))}
          </ul>
        </div>
      )}
      {nonBlockingRecheck.length > 0 && (
        <>
          <h4>加工後の再検査</h4>
          <ul>
            {nonBlockingRecheck.map((f) => (
              <li key={f.message}>{f.message}</li>
            ))}
          </ul>
        </>
      )}
      {result.opIssues.length > 0 && (
        <>
          <h4>手動操作</h4>
          <ul>
            {result.opIssues.map((i) => (
              <li key={`${i.opIndex}-${i.reason}`}>
                {i.kind === 'rejected' ? '適用できません: ' : '再確認が必要です: '}
                {i.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>検査の状態</h4>
      <ul className="compact">
        {result.engines.map((e) => (
          <li key={e.engine}>
            {ENGINE_NAME[e.engine]}:{' '}
            {e.status === 'ok' ? `実行（${e.spanCount}件${e.ms ? `・${e.ms}ms` : ''}）` : e.status === 'skipped' ? '設定で無効' : `使えません（${e.reason}）`}
          </li>
        ))}
        {result.coverage
          .filter((c) => c.status !== '検査済')
          .map((c) => (
            <li key={`${c.start}-${c.end}`}>
              {c.status}: {c.reason}
            </li>
          ))}
      </ul>
      {result.candidates.length === 0 && result.text.trim() && <p className="hint">設定した検査では候補が見つかりませんでした。見逃しがないことの保証ではありません。</p>}
    </div>
  );
}
