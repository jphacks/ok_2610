import type { EngineOutput } from '../core/analyze';
import type { ConditionsResult } from '../core/conditions';
import type { AnalysisResult, ManualOp, Settings } from '../core/model/types';
import type { RestoreResult } from '../core/restore';

// サイドパネルと Analysis Worker の間でやり取りするメッセージ。構造化クローンできる値だけを使う

export type AnalyzeRequest = {
  text: string;
  settings: Settings;
  ops: ManualOp[];
  /** chrome.storage.managed から読んだ組織ポリシー（検証は Worker 側で行う） */
  policyRaw: unknown;
  nowIso: string;
  conditions: ConditionsResult;
  /** サイドパネルで実行した Gemini Nano の結果 */
  nano?: EngineOutput;
};

export type WorkerRequest =
  | { id: number; type: 'analyze'; payload: AnalyzeRequest }
  | { id: number; type: 'restore'; payload: { text: string; restoreMap: Record<string, string>; generalizedMap: Record<string, string> } }
  | { id: number; type: 'nerStatus' };

export type WorkerResponseMap = {
  analyze: AnalysisResult & { policy: PolicySummary };
  restore: RestoreResult;
  nerStatus: { ok: boolean; reason?: string };
};

export type PolicySummary =
  | { status: 'none' }
  | { status: 'active'; version: string; name?: string; contact?: string; minStage: string; requireConditions: boolean; allowedOrigins?: string[] }
  | { status: 'error'; reason: string };

export type WorkerResponse =
  | { id: number; ok: true; result: WorkerResponseMap[keyof WorkerResponseMap] }
  | { id: number; ok: false; error: string };
