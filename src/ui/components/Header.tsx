import { useStore } from '../store';
import { Icon } from './Icon';

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
  const link =
    destination.kind === 'insert'
      ? { tone: 'ok', label: `連携: ${destination.siteName}` }
      : { tone: 'muted', label: destination.kind === 'file' ? '連携: ファイル保存' : '連携: コピーのみ' };
  const hasResult = !!text.trim() && !!result?.text.trim();

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-icon"><Icon name="shield" /></span>
        <div>
          <h1>テキストクリーナー</h1>
          <p className="subtitle">AIに渡す前に、文章を整える。</p>
        </div>
      </div>
      <div className="chips" aria-label="状態">
        {[check, policyChip, link].map((c) => (
          <span key={c.label} className={`chip chip-${c.tone}`}>
            {c.label}
          </span>
        ))}
      </div>
      <nav className="workflow" aria-label="作業の流れ">
        <a href="#input-title"><span>01</span> 文章の準備</a>
        {hasResult ? <a href="#result-title"><span>02</span> 加工文の確認</a> : <span className="workflow-disabled"><span>02</span> 加工文の確認</span>}
        {hasResult ? <a href="#output-title"><span>03</span> コピー・利用</a> : <span className="workflow-disabled"><span>03</span> コピー・利用</span>}
      </nav>
    </header>
  );
}
