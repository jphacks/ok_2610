import { useStore } from '../store';

/** 検査状態・ポリシー状態・連携状態を分けて表示する（SF-01）。「保護中」とは書かない */
export function Header() {
  const { result, analyzing, text, destination, error } = useStore();
  const check = !text.trim()
    ? { tone: 'muted', label: '未入力' }
    : analyzing
      ? { tone: 'muted', label: '解析中…' }
      : error || result?.coverage.some((c) => c.status === '解析不能')
        ? { tone: 'danger', label: '解析不能あり' }
        : result
          ? { tone: 'ok', label: result.blockers.length ? '検査完了・停止中' : '検査完了' }
          : { tone: 'muted', label: '待機中' };
  const policy = result?.policy;
  const policyChip =
    !policy || policy.status === 'none'
      ? { tone: 'muted', label: 'ポリシーなし' }
      : policy.status === 'active'
        ? { tone: 'ok', label: `ポリシー ${policy.version}` }
        : { tone: 'danger', label: 'ポリシー読込み失敗' };
  const link = destination.kind === 'insert' ? { tone: 'ok', label: `連携: ${destination.siteName}` } : { tone: 'muted', label: '連携: コピーのみ' };

  return (
    <header className="header">
      <h1>テキストクリーナー</h1>
      <p className="subtitle">AIに渡す前の個人情報チェック</p>
      <div className="chips" aria-label="状態">
        {[check, policyChip, link].map((c) => (
          <span key={c.label} className={`chip chip-${c.tone}`}>
            {c.label}
          </span>
        ))}
      </div>
    </header>
  );
}
