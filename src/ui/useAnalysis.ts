import { useEffect, useRef } from 'react';
import { evaluateConditions } from '../core/conditions';
import { parseCustomTerms } from '../core/detect/dictionary';
import { nanoAvailability } from '../engines/nano';
import { log } from '../infra/logger';
import { loadPrefs, onManagedPolicyChanged, onPendingText, readManagedPolicy, savePrefs, takePendingText } from '../infra/storage';
import { sessionNano, workerClient } from '../infra/analysis-session';
import { settingsFrom, useStore } from './store';

const DEBOUNCE_MS = 350;

/**
 * 入力・設定・手動操作・利用条件・組織ポリシーが変わるたびに解析し直す。
 * 非同期の結果は依頼番号で照合し、古い結果が新しい入力を上書きしないようにする（§9-2 追い越し対策）。
 */
export function useAnalysis() {
  const text = useStore((s) => s.text);
  const prefs = useStore((s) => s.prefs);
  const ops = useStore((s) => s.ops);
  const answers = useStore((s) => s.answers);
  const revision = useStore((s) => s.revision);
  const loaded = useRef(false);

  // 起動時: 設定・エンジンの状態・右クリックの受け渡しを読む
  useEffect(() => {
    let disposed = false;
    const sessionId = useStore.getState().sessionId;
    const active = () => !disposed && useStore.getState().sessionId === sessionId;
    void (async () => {
      const p = await loadPrefs();
      if (!active()) return;
      useStore.getState().setPrefs(p);
      loaded.current = true;
      const pending = await takePendingText();
      if (!active()) return;
      if (pending) useStore.getState().setText(pending);
      try {
        const status = await workerClient().call('nerStatus');
        if (active()) useStore.getState().setNerStatus(status);
      } catch { /* 削除による Worker の終了時は結果を反映しない */ }
      const nano = await nanoAvailability();
      if (active()) useStore.getState().setNanoStatus(nano);
    })();
    const offPending = onPendingText((t) => useStore.getState().setText(t), () => useStore.getState().sessionId);
    const offPolicy = onManagedPolicyChanged(() => useStore.getState().policyChanged());
    return () => {
      disposed = true;
      offPending();
      offPolicy();
    };
  }, []);

  useEffect(() => {
    if (loaded.current) void savePrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    const conditions = evaluateConditions(answers);
    useStore.getState().setConditions(conditions);
    let disposed = false;
    const active = () => !disposed && revision === useStore.getState().revision;
    const timer = setTimeout(async () => {
      if (!active()) return;
      const store = useStore.getState();
      store.setAnalyzing(true);
      store.setError(null);
      const t0 = performance.now();
      try {
        const settings = settingsFrom(prefs, parseCustomTerms(prefs.customText));
        const nano = prefs.useNano && text.trim() ? await sessionNano(text) : undefined;
        if (!active()) return;
        const policyRaw = await readManagedPolicy();
        if (!active()) return;
        const result = await workerClient().call('analyze', {
          text,
          settings,
          ops,
          policyRaw,
          nowIso: new Date().toISOString(),
          conditions,
          ...(nano ? { nano } : {}),
        });
        if (!active()) return;
        store.setResult(result, revision);
        log('analyze', { ms: Math.round(performance.now() - t0), candidates: result.candidates.length, blockers: result.blockers.length });
      } catch (e) {
        if (active()) store.setError(e instanceof Error ? e.message : '解析できませんでした');
      } finally {
        if (active()) store.setAnalyzing(false);
      }
    }, DEBOUNCE_MS);
    return () => { disposed = true; clearTimeout(timer); };
  }, [text, prefs, ops, answers, revision]);
}
