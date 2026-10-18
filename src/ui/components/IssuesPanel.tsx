import { useStore } from '../store';
import type { SettingsSection } from './SettingsDialog';

const ENGINE_NAME = { rule: '規則', ner: 'NER', nano: 'Gemini Nano' } as const;

/** 停止理由は常時表示し、正常な検査ログだけを折りたたむ。 */
export function IssuesPanel({ onSettings }: { onSettings: (section?: SettingsSection) => void }) {
  const result = useStore((s) => s.result);
  if (!result) return null;
  const nonBlockingRecheck = result.recheck.filter((f) => !f.blocking);
  return (
    <div className="issues-panel">
      {result.blockers.length > 0 && (
        <div className="callout danger" role="alert">
          <strong>出力を止めています</strong>
          <ul>{result.blockers.map((b) => <li key={b.message}>{b.message}</li>)}</ul>
          <button type="button" onClick={() => onSettings(result.blockers.some(b => b.kind === 'conditions') ? 'conditions' : 'preferences')}>設定を確認する</button>
        </div>
      )}
      {nonBlockingRecheck.length > 0 && <div className="callout warn"><strong>加工後の再検査</strong><ul>{nonBlockingRecheck.map(f => <li key={f.message}>{f.message}</li>)}</ul></div>}
      {result.opIssues.length > 0 && <div className="callout warn"><strong>手動操作の確認</strong><ul>{result.opIssues.map(i => <li key={`${i.opIndex}-${i.reason}`}>{i.kind === 'rejected' ? '適用できません: ' : '再確認が必要です: '}{i.reason}</li>)}</ul></div>}
      <details className="inspection-details">
        <summary>検査の詳細</summary>
        <ul className="compact">{result.engines.map(e => <li key={e.engine}>{ENGINE_NAME[e.engine]}: {e.status === 'ok' ? `実行（${e.spanCount}件${e.ms ? `・${e.ms}ms` : ''}）` : e.status === 'skipped' ? '設定で無効' : `使えません（${e.reason}）`}</li>)}
          {result.coverage.filter(c => c.status !== '検査済').map(c => <li key={`${c.start}-${c.end}`}>{c.status}: {c.reason}</li>)}
        </ul>
      </details>
      {result.candidates.length === 0 && result.text.trim() && <p className="hint">検出候補はありません。見逃しがないことの保証ではありません。</p>}
    </div>
  );
}
