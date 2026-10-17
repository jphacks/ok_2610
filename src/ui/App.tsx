import { MESSAGES } from '../core/explain/messages';
import { ConditionsPanel } from './components/ConditionsPanel';
import { DetailPanel } from './components/DetailPanel';
import { Header } from './components/Header';
import { InputPanel } from './components/InputPanel';
import { IssuesPanel } from './components/IssuesPanel';
import { OutputPanel } from './components/OutputPanel';
import { Preview } from './components/Preview';
import { RestorePanel } from './components/RestorePanel';
import { RiskPanel } from './components/RiskPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { useStore } from './store';
import { useAnalysis } from './useAnalysis';

export function App() {
  useAnalysis();
  const notice = useStore((s) => s.notice);
  const error = useStore((s) => s.error);
  const hasText = useStore((s) => s.text.trim().length > 0);
  const result = useStore((s) => s.result);

  return (
    <div className="app">
      <Header />
      {notice && (
        <p className="banner" role="status">
          {notice}
          <button type="button" className="link" onClick={() => useStore.getState().setNotice(null)}>
            閉じる
          </button>
        </p>
      )}
      {error && (
        <p className="banner danger" role="alert">
          {MESSAGES.analysisFailed}（{error}）
        </p>
      )}
      <main>
        <InputPanel />
        <SettingsPanel />
        {hasText && (
          <section className="panel results-panel" aria-labelledby="result-title">
            <div className="section-heading">
              <div>
                <h2 id="result-title">結果</h2>
                <p className="hint">残る手がかりと加工文を確認してください。</p>
              </div>
              {result && <span className="text-count">検出 {result.candidates.length} 箇所</span>}
            </div>
            <RiskPanel />
            <Preview />
            <DetailPanel />
            <IssuesPanel />
          </section>
        )}
        <ConditionsPanel />
        <OutputPanel />
        <RestorePanel />
      </main>
      <footer className="footer">
        <p>{MESSAGES.noGuarantee}</p>
        <p>{MESSAGES.externalNotChecked}</p>
      </footer>
    </div>
  );
}
