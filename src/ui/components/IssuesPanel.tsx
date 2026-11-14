import { useStore } from '../store';
import type { SettingsSection } from './SettingsDialog';

const ENGINE_NAME = { rule: '規則', ner: 'NER', nano: 'Gemini Nano' } as const;

/** 停止理由は常時表示し、正常な検査ログだけを折りたたむ。 */
export function IssuesPanel({ onSettings }: { onSettings: (section?: SettingsSection) => void }) {
  const result = useStore((s) => s.result);
  // 入力直後は前の文章（空の文章を含む）の結果が残っているので、検査が追いつくまで停止理由を出さない
  const fresh = useStore((s) => !s.analyzing && s.resultRevision === s.revision);
  if (!result) return null;
  const nonBlockingRecheck = result.recheck.filter((f) => !f.blocking);
  const fix: { section: SettingsSection; label: string } | null = result.blockers.some((b) => b.kind === 'conditions')
    ? { section: 'conditions', label: '利用条件に回答する' }
    : result.blockers.some((b) => b.kind === 'engineFailed')
      ? { section: 'preferences', label: '検査の設定を開く' }
      : null;
  return (
    <div className="issues-panel">
      {fresh && result.blockers.length > 0 && (
        <div className="callout danger" role="alert">
          <strong>出力を止めています</strong>
          <ul>{result.blockers.map((b) => <li key={b.message}>{b.message}</li>)}</ul>
          {/* 設定で直せる理由のときだけ、直す場所へ案内する（秘密の値などは設定では直らない） */}
          {fix && <button type="button" onClick={() => onSettings(fix.section)}>{fix.label}</button>}
        </div>
      )}
      {nonBlockingRecheck.length > 0 && <div className="callout warn"><strong>再検査で見つかった語</strong><ul>{nonBlockingRecheck.map(f => <li key={f.message}>{f.message}</li>)}</ul></div>}
      {result.opIssues.length > 0 && <div className="callout warn"><strong>手で直した箇所</strong><ul>{result.opIssues.map(i => <li key={`${i.opIndex}-${i.reason}`}>{i.kind === 'rejected' ? '適用できません: ' : '要確認: '}{i.reason}</li>)}</ul></div>}
      <details className="inspection-details">
        <summary>検査の詳細</summary>
        <ul className="compact">{result.engines.map(e => <li key={e.engine}>{ENGINE_NAME[e.engine]}: {e.status === 'ok' ? `実行（${e.spanCount}件${e.ms ? `・${e.ms}ms` : ''}）` : e.status === 'skipped' ? '設定で無効' : `使えません（${e.reason}）`}</li>)}
          {result.coverage.filter(c => c.status !== '検査済').map(c => <li key={`${c.start}-${c.end}`}>{c.status}: {c.reason}</li>)}
        </ul>
      </details>
      {result.candidates.length === 0 && result.text.trim() && <p className="hint">検出なし（見逃しがないとは限りません）</p>}
    </div>
  );
}

/** API キーやパスワードなど、消すしかない値を消したことを結果のいちばん上で伝える（本文の中の印だけでは気づきにくい） */
export function SecretNotice() {
  const result = useStore((s) => s.result);
  const fresh = useStore((s) => !s.analyzing && s.resultRevision === s.revision);
  if (!result || !fresh) return null;
  const secrets = result.candidates.filter((c) => c.categories.includes('credential') && c.action.kind !== 'keep');
  if (!secrets.length) return null;
  return (
    <p className="secret-notice" role="status">
      API キーやパスワードなどの秘密の値を{secrets.length}件消しました。この値は残せません。
    </p>
  );
}
