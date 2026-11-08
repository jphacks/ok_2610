import { useEffect } from 'react';
import { REPORTED_BLOCKERS, summarizeUsage, usageDestination } from '../core/usage';
import type { Stage } from '../core/model/types';
import { maxStage } from '../core/transform/stages';
import { flushUsage, recordUsage } from '../infra/reporting';
import { useStore, type State } from './store';

// サイドパネルから利用記録を作る入口。送るかどうか（組織ポリシー）は infra/reporting.ts が判断する。

function effectiveStage(s: State): Stage {
  const policy = s.result?.policy;
  return policy?.status === 'active' ? maxStage(s.prefs.stage, policy.minStage as Stage) : s.prefs.stage;
}

/** 出力（コピー・挿入・保存）が済んだときに1件記録する */
export function reportOutput(): void {
  const s = useStore.getState();
  if (!s.result) return;
  void recordUsage(summarizeUsage(s.result, {
    kind: 'output',
    stage: effectiveStage(s),
    purpose: s.prefs.purpose,
    manualOps: s.ops.length,
    destination: usageDestination(s.destination),
  }));
}

/** 起動時に溜まった記録を送り、停止理由（認証情報・禁止情報・ポリシー）はセッションにつき種類ごとに1回だけ記録する */
export function useUsageReporting(): void {
  useEffect(() => {
    void flushUsage();
    const reported = new Set<string>();
    return useStore.subscribe((s) => {
      if (!s.result || s.analyzing || s.resultRevision !== s.revision) return;
      const fresh = s.result.blockers
        .map((b) => b.kind)
        .filter((k) => (REPORTED_BLOCKERS as readonly string[]).includes(k) && !reported.has(`${s.sessionId}:${k}`));
      if (!fresh.length) return;
      for (const k of fresh) reported.add(`${s.sessionId}:${k}`);
      void recordUsage(summarizeUsage(s.result, { kind: 'blocked', stage: effectiveStage(s), purpose: s.prefs.purpose, manualOps: s.ops.length, destination: null }));
    });
  }, []);
}
