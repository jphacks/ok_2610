import { useStore } from '../store';
import { Icon } from './Icon';

export function Header({ onSettings }: { onSettings: () => void }) {
  const { result, analyzing, text, error } = useStore();
  const check = !text.trim() ? null : analyzing
    ? { tone: 'muted', label: '解析中…' }
    : error || result?.coverage.some((c) => c.status === '解析不能')
      ? { tone: 'danger', label: '解析できません' }
      : result ? { tone: result.blockers.length ? 'danger' : 'ok', label: result.blockers.length ? '出力停止中' : '検査完了' } : null;
  return (
    <header className="header">
      <div className="brand"><span className="brand-icon"><Icon name="shield" /></span><h1>テキストクリーナー</h1></div>
      <div className="header-actions">
        {check && <span className={`chip chip-${check.tone} check-status`} role="status">{check.label}</span>}
        <button type="button" className="icon-button ghost" onClick={onSettings} aria-label="設定を開く" title="設定"><Icon name="settings" /></button>
      </div>
    </header>
  );
}
