import { useState } from 'react';
import { useStore } from '../store';
import { DetailPanel } from './DetailPanel';
import { IssuesPanel, SecretNotice } from './IssuesPanel';
import { OutputPanel } from './OutputPanel';
import { Preview } from './Preview';
import { RiskPanel } from './RiskPanel';
import type { SettingsSection } from './SettingsDialog';

export function ReviewPanel({ onSettings }: { onSettings: (section?: SettingsSection) => void }) {
  const { result, analyzing } = useStore();
  const [mode, setMode] = useState<'masked' | 'original'>('masked');
  return (
    <>
      <section className="panel results-panel" aria-labelledby="result-title" aria-busy={analyzing}>
        <div className="step-heading">
          <span className="step-num" aria-hidden="true">2</span>
          <h2 id="result-title">加工を確認</h2>
          <span className="step-meta">{analyzing || !result ? '検査中…' : `${result.candidates.length} 箇所`}</span>
        </div>
        <SecretNotice />
        <RiskPanel />
        <Preview mode={mode} onMode={setMode} detail={<DetailPanel />} />
        <IssuesPanel onSettings={onSettings} />
      </section>
      <OutputPanel onConditions={() => onSettings('conditions')} showingOriginal={mode === 'original'} onShowMasked={() => setMode('masked')} />
    </>
  );
}
