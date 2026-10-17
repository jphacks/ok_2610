import { useEffect, useRef } from 'react';
import { evaluateConditions } from '../core/conditions';
import { parseCustomTerms } from '../core/detect/dictionary';
import type { EngineOutput } from '../core/analyze';
import { detectNano, nanoAvailability } from '../engines/nano';
import { log } from '../infra/logger';
import { loadPrefs, onManagedPolicyChanged, onPendingText, readManagedPolicy, savePrefs, takePendingText } from '../infra/storage';
import { createWorkerClient, type WorkerClient } from '../infra/worker-client';
import { settingsFrom, useStore } from './store';

const DEBOUNCE_MS = 350;

let client: WorkerClient | null = null;
export function workerClient(): WorkerClient {
  client ??= createWorkerClient();
  return client;
}

/**
 * 入力・設定・手動操作・利用条件・組織ポリシーが変わるたびに解析し直す。
 * 非同期の結果は依頼番号で照合し、古い結果が新しい入力を上書きしないようにする（§9-2 追い越し対策）。
 */
export function useAnalysis() {
  const text = useStore((s) => s.text);
  const prefs = useStore((s) => s.prefs);
  const ops = useStore((s) => s.ops);
  const answers = useStore((s) => s.answers);
  const requestRef = useRef(0);
  const nanoCache = useRef(new Map<string, EngineOutput>());
  const policyTick = useStore((s) => s.notice);
  const loaded = useRef(false);

  // 起動時: 設定・エンジンの状態・右クリックの受け渡しを読む
  useEffect(() => {
    void (async () => {
      const p = await loadPrefs();
      useStore.getState().setPrefs(p);
      loaded.current = true;
      const pending = await takePendingText();
      if (pending) useStore.getState().setText(pending);
      useStore.getState().setNerStatus(await workerClient().call('nerStatus'));
      useStore.getState().setNanoStatus(await nanoAvailability());
    })();
    const offPending = onPendingText((t) => useStore.getState().setText(t));
    const offPolicy = onManagedPolicyChanged(() => useStore.getState().setNotice('組織ポリシーが更新されました'));
    return () => {
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
    const id = ++requestRef.current;
    const timer = setTimeout(async () => {
      const store = useStore.getState();
      store.setAnalyzing(true);
      store.setError(null);
      const t0 = performance.now();
      try {
        const settings = settingsFrom(prefs, parseCustomTerms(prefs.customText));
        let nano: EngineOutput | undefined;
        if (prefs.useNano && text.trim()) {
          nano = nanoCache.current.get(text) ?? (await detectNano(text));
          if (nano.status === 'ok') nanoCache.current.set(text, nano);
        }
        if (id !== requestRef.current) return;
        const result = await workerClient().call('analyze', {
          text,
          settings,
          ops,
          policyRaw: await readManagedPolicy(),
          nowIso: new Date().toISOString(),
          conditions,
          ...(nano ? { nano } : {}),
        });
        if (id !== requestRef.current) return;
        store.setResult(result);
        log('analyze', { ms: Math.round(performance.now() - t0), candidates: result.candidates.length, blockers: result.blockers.length });
      } catch (e) {
        if (id === requestRef.current) store.setError(e instanceof Error ? e.message : '解析できませんでした');
      } finally {
        if (id === requestRef.current) store.setAnalyzing(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, prefs, ops, answers, policyTick]);
}
