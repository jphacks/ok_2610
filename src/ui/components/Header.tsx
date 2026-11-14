import { PURPOSE_LABEL } from '../labels';
import { useStore } from '../store';
import { Icon } from './Icon';

/**
 * 拡張名は Chrome のサイドパネル上部に出るので繰り返さない。
 * 左は検査の状態（押せない表示）、右はいまの設定を書いた設定ボタン（押せるのはここだけ）。
 */
export function Header({ onSettings }: { onSettings: () => void }) {
  const { result, analyzing, text, error, prefs, revision, resultRevision } = useStore();
  const fresh = !analyzing && resultRevision === revision;
  const check = !text.trim() ? { tone: 'idle', label: '未入力' } : !fresh
    ? { tone: 'busy', label: '検査中…' }
    : error || result?.coverage.some((c) => c.status === '解析不能')
      ? { tone: 'danger', label: '解析できません' }
      : result ? { tone: result.blockers.length ? 'danger' : 'ok', label: result.blockers.length ? '出力停止中' : '検査完了' } : { tone: 'busy', label: '検査中…' };
  const reporting = result?.policy.status === 'active' && result.policy.reporting;
  return (
    <header className="header">
      <div className="header-status">
        <span className={`status status-${check.tone}`} role="status">{check.label}</span>
        {reporting && <span className="status-report" title="文章を含まない利用記録を組織へ送っています。内容は設定画面で確認できます">記録：組織へ送信</span>}
      </div>
      <button type="button" className="settings-button" onClick={onSettings} aria-label="設定を開く" aria-describedby="header-prefs" title="設定を開く">
        <span id="header-prefs">{PURPOSE_LABEL[prefs.purpose]}・段階{prefs.stage}</span>
        <Icon name="settings" />
      </button>
    </header>
  );
}
