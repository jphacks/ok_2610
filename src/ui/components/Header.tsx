import { PURPOSE_LABEL } from '../labels';
import { useStore } from '../store';
import { Icon } from './Icon';

/** 拡張名は Chrome のサイドパネル上部に出るので繰り返さない。検査の状態と、いまの設定だけを示す。 */
export function Header({ onSettings }: { onSettings: () => void }) {
  const { result, analyzing, text, error, prefs, revision, resultRevision } = useStore();
  const fresh = !analyzing && resultRevision === revision;
  const check = !text.trim() ? null : !fresh
    ? { tone: 'muted', label: '検査中…' }
    : error || result?.coverage.some((c) => c.status === '解析不能')
      ? { tone: 'danger', label: '解析できません' }
      : result ? { tone: result.blockers.length ? 'danger' : 'ok', label: result.blockers.length ? '出力停止中' : '検査完了' } : null;
  return (
    <header className="header">
      <ul className="tags" aria-label="現在の設定">
        {check && <li className={`tag tag-${check.tone}`} role="status">{check.label}</li>}
        <li className="tag">{PURPOSE_LABEL[prefs.purpose]}</li>
        <li className="tag">段階 {prefs.stage}</li>
      </ul>
      <button type="button" className="icon-button ghost" onClick={onSettings} aria-label="設定を開く" title="設定"><Icon name="settings" /></button>
    </header>
  );
}
