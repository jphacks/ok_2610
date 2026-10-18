import { useState } from 'react';
import { MESSAGES } from '../core/explain/messages';
import { Header } from './components/Header';
import { InputPanel } from './components/InputPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { RestorePanel } from './components/RestorePanel';
import { SettingsDialog, type SettingsSection } from './components/SettingsDialog';
import { Icon } from './components/Icon';
import { PURPOSE_LABEL, STAGE_INFO } from './labels';
import { useStore } from './store';
import { useAnalysis } from './useAnalysis';

export function App() {
  useAnalysis();
  const { notice, error, text, result, sessionId, prefs, conditions } = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('preferences');
  const hasText = text.trim().length > 0;
  function openSettings(section: SettingsSection = 'preferences') {
    setSettingsSection(section);
    setSettingsOpen(true);
  }
  return (
    <div className="app">
      <Header onSettings={() => openSettings()} />
      {notice && <p className="banner" role="status">{notice}<button type="button" className="link" onClick={() => useStore.getState().setNotice(null)}>閉じる</button></p>}
      {error && <p className="banner danger" role="alert">{MESSAGES.analysisFailed}（{error}）</p>}
      <main>
        <InputPanel key={`input:${sessionId}`} />
        <button type="button" className="preferences-shortcut" onClick={() => openSettings()} aria-label="加工の設定を開く">
          <span><Icon name="settings" />{PURPOSE_LABEL[prefs.purpose]}<span className="separator">/</span>{STAGE_INFO[prefs.stage].name.slice(2)}</span><span className="shortcut-label">変更 <Icon name="chevron" /></span>
        </button>
        {hasText && <ReviewPanel key={`review:${sessionId}`} onSettings={openSettings} />}
        <div className="utility-row">
          <button type="button" className="utility-link" onClick={() => openSettings('conditions')}><Icon name="check" />利用条件<span className={`utility-status ${conditions.status === 'unknown' || conditions.status === 'restricted' ? 'attention' : ''}`}>{conditions.status === 'unanswered' ? '未回答' : conditions.status === 'selfDeclaredOk' ? '回答済み' : '要確認'}</span><Icon name="chevron" /></button>
          <span className={`policy-status ${result?.policy.status === 'error' ? 'attention' : ''}`}>{result?.policy.status === 'active' ? `組織ポリシー ${result.policy.version}` : result?.policy.status === 'error' ? 'ポリシー読込み失敗' : '組織ポリシーなし'}</span>
        </div>
        <RestorePanel key={`${sessionId}:${result?.contentId ?? ''}`} />
      </main>
      <footer className="footer">
        <span className="local-note"><Icon name="shield" />文章の検査は端末内で行います</span>
        <details><summary>データの扱い・注意点</summary><p>{MESSAGES.sessionScope}</p><p>{MESSAGES.clipboardNote}</p><p>{MESSAGES.noGuarantee}</p><p>{MESSAGES.externalNotChecked}</p></details>
      </footer>
      <SettingsDialog open={settingsOpen} section={settingsSection} onSection={setSettingsSection} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
