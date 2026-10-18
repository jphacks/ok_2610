import { useState } from 'react';
import { useStore } from '../store';
import { DetailPanel } from './DetailPanel';
import { IssuesPanel } from './IssuesPanel';
import { OutputPanel } from './OutputPanel';
import { Preview } from './Preview';
import { RiskPanel } from './RiskPanel';
import type { SettingsSection } from './SettingsDialog';

export function ReviewPanel({ onSettings }: { onSettings: (section?: SettingsSection) => void }) {
  const { result, analyzing } = useStore();
  const [mode, setMode] = useState<'masked' | 'original'>('masked');
  return (
    <section className="panel results-panel" aria-labelledby="result-title" aria-busy={analyzing}>
      <div className="section-heading"><h2 id="result-title">加工した文章</h2><span className="text-count">{analyzing ? '更新中…' : result ? `${result.candidates.length} 箇所を検出` : '解析を待っています'}</span></div>
      <RiskPanel />
      <Preview mode={mode} onMode={setMode} />
      <DetailPanel />
      <IssuesPanel onSettings={onSettings} />
      <OutputPanel onConditions={() => onSettings('conditions')} showingOriginal={mode === 'original'} onShowMasked={() => setMode('masked')} />
    </section>
  );
}
