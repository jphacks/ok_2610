import { useState } from 'react';
import { MESSAGES } from '../core/explain/messages';
import { EmptyGuide } from './components/EmptyGuide';
import { Header } from './components/Header';
import { InputPanel } from './components/InputPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { RestorePanel } from './components/RestorePanel';
import { SettingsDialog, type SettingsSection } from './components/SettingsDialog';
import { Icon } from './components/Icon';
import { POLICY_ERROR_LABEL, POLICY_SOURCE_LABEL } from './labels';
import { useStore } from './store';
import { useAnalysis } from './useAnalysis';
import { useUsageReporting } from './usage';

export function App() {
  useAnalysis();
  useUsageReporting();
  const { notice, error, text, result, sessionId, conditions, source } = useStore();
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
        {hasText ? <ReviewPanel key={`review:${sessionId}`} onSettings={openSettings} /> : !source && <EmptyGuide />}
        <div className="utility-row">
          <button type="button" className="utility-link" onClick={() => openSettings('conditions')}><Icon name="check" />利用条件<span className={`utility-status ${conditions.status === 'unknown' || conditions.status === 'restricted' ? 'attention' : ''}`}>{conditions.status === 'unanswered' ? '未回答' : conditions.status === 'selfDeclaredOk' ? '回答済み' : '要確認'}</span><Icon name="chevron" /></button>
          <span
            className={`policy-status ${result?.policy.status === 'error' ? 'attention' : ''}`}
            title={result?.policy.status === 'error' ? result.policy.reason : result?.policy.status === 'active' ? `配布元：${POLICY_SOURCE_LABEL[result.policy.source]}` : undefined}
          >
            {result?.policy.status === 'active'
              ? `組織ポリシー ${result.policy.version}（${POLICY_SOURCE_LABEL[result.policy.source]}）`
              : result?.policy.status === 'error' ? POLICY_ERROR_LABEL[result.policy.state] : '組織ポリシーなし'}
          </span>
        </div>
        <RestorePanel key={`${sessionId}:${result?.contentId ?? ''}`} />
      </main>
      <SettingsDialog open={settingsOpen} section={settingsSection} onSection={setSettingsSection} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
