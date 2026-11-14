import type { EngineOutput } from '../core/analyze';
import type { ConditionsResult } from '../core/conditions';
import type { PolicyInput } from '../core/policy';
import type { PolicySource, PolicyState } from '../../shared/management';
import type { AnalysisResult, ManualOp, Settings } from '../core/model/types';
import type { RestoreResult } from '../core/restore';

// サイドパネルと Analysis Worker の間でやり取りするメッセージ。構造化クローンできる値だけを使う

export type AnalyzeRequest = {
  text: string;
  settings: Settings;
  ops: ManualOp[];
  /** chrome.storage.managed から読んだ組織ポリシー（検証は Worker 側で行う） */
  /** サイドパネルが managed storage とサーバーの署名を読んで組み立てたもの（Worker からは chrome.storage を読めない） */
  policyInput: PolicyInput;
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
  | { status: 'active'; source: PolicySource; version: string; name?: string; contact?: string; minStage: string; requireConditions: boolean; allowedOrigins?: string[]; /** 利用記録を組織へ送るか */ reporting: boolean }
  | { status: 'error'; source: PolicySource; state: Exclude<PolicyState, 'active'>; reason: string };

export type WorkerResponse =
  | { id: number; ok: true; result: WorkerResponseMap[keyof WorkerResponseMap] }
  | { id: number; ok: false; error: string };
