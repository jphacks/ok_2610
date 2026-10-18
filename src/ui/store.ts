import { create } from 'zustand';
import type { Answer, ConditionsResult } from '../core/conditions';
import type { AnalysisResult, ManualOp, Settings } from '../core/model/types';
import type { PolicySummary } from '../worker/protocol';
import type { SpreadsheetSource } from '../infra/spreadsheet';
import type { NanoAvailability } from '../engines/nano';
import { clearPendingText, DEFAULT_PREFS, type Prefs } from '../infra/storage';
import { clearAnalysisSession } from '../infra/analysis-session';

// サイドパネルの状態。原文・対応表・解析結果はメモリにだけ置き、パネルを閉じれば消える。

export type Destination = { kind: 'copy' } | { kind: 'file' } | { kind: 'insert'; tabId: number; origin: string; siteId: string; siteName: string };

export const destinationKey = (d: Destination) => (d.kind === 'insert' ? `insert:${d.tabId}:${d.origin}` : d.kind);

export type Confirmed = { contentId: string; destinationKey: string; masked: string };

type State = {
  revision: number;
  resultRevision: number | null;
  sessionId: number;
  confirmationInvalidated: boolean;
  text: string;
  /** 読み込んだ Excel・CSV。本文を書き換えたら消す（同じ形式での保存は、読み込んだままの本文にだけ使える） */
  source: SpreadsheetSource | null;
  prefs: Prefs;
  ops: ManualOp[];
  /** 元に戻す単位。まとめて適用した操作は1つのまとまりとして戻す（FR-19） */
  groups: number[];
  redo: ManualOp[][];
  result: (AnalysisResult & { policy: PolicySummary }) | null;
  analyzing: boolean;
  error: string | null;
  selectedId: string | null;
  confirmed: Confirmed | null;
  destination: Destination;
  answers: Record<string, Answer | undefined>;
  conditions: ConditionsResult;
  nerStatus: { ok: boolean; reason?: string } | null;
  nanoStatus: NanoAvailability | null;
  nanoProgress: number | null;
  notice: string | null;
};

type Actions = {
  setText: (text: string) => void;
  importFile: (source: SpreadsheetSource) => void;
  setPrefs: (patch: Partial<Prefs>) => void;
  addOp: (op: ManualOp) => void;
  addOps: (ops: ManualOp[]) => void;
  undo: () => void;
  redoOp: () => void;
  setResult: (r: State['result'], revision: number) => void;
  setAnalyzing: (v: boolean) => void;
  setError: (e: string | null) => void;
  select: (id: string | null) => void;
  confirm: (c: Confirmed | null) => void;
  setDestination: (d: Destination) => void;
  setAnswer: (id: string, a: Answer) => void;
  setConditions: (c: ConditionsResult) => void;
  setNerStatus: (s: State['nerStatus']) => void;
  setNanoStatus: (s: NanoAvailability | null) => void;
  setNanoProgress: (p: number | null) => void;
  setNotice: (n: string | null) => void;
  policyChanged: () => void;
  /** 「終了して削除」: 原文・対応表・手動操作・確認状態をすべて消す */
  reset: () => void;
};

const initial: State = {
  revision: 0,
  resultRevision: null,
  sessionId: 0,
  confirmationInvalidated: false,
  text: '',
  source: null,
  prefs: DEFAULT_PREFS,
  ops: [],
  groups: [],
  redo: [],
  result: null,
  analyzing: false,
  error: null,
  selectedId: null,
  confirmed: null,
  destination: { kind: 'copy' },
  answers: {},
  conditions: { status: 'unanswered', restricted: [], consult: [] },
  nerStatus: null,
  nanoStatus: null,
  nanoProgress: null,
  notice: null,
};

const invalidate = (s: State) => ({
  revision: s.revision + 1,
  confirmed: null,
  confirmationInvalidated: s.confirmationInvalidated || s.confirmed !== null,
  analyzing: true,
  error: null,
});

export const useStore = create<State & Actions>((set) => ({
  ...initial,
  // 本文が変われば手動操作の位置は意味を失うので消す
  setText: (text) =>
    set((s) => ({
      ...invalidate(s),
      text,
      ops: [],
      groups: [],
      redo: [],
      selectedId: null,
      source: null,
      ...(s.destination.kind === 'file' ? { destination: { kind: 'copy' } as const } : {}),
    })),
  importFile: (source) => set((s) => ({ ...invalidate(s), text: source.text, source, ops: [], groups: [], redo: [], selectedId: null })),
  setPrefs: (patch) => set((s) => ({ ...invalidate(s), prefs: { ...s.prefs, ...patch } })),
  addOp: (op) => set((s) => ({ ...invalidate(s), ops: [...s.ops, op], groups: [...s.groups, 1], redo: [] })),
  addOps: (ops) => set((s) => (ops.length ? { ...invalidate(s), ops: [...s.ops, ...ops], groups: [...s.groups, ops.length], redo: [] } : s)),
  undo: () =>
    set((s) => {
      const size = s.groups.at(-1);
      if (!size) return s;
      return { ...invalidate(s), ops: s.ops.slice(0, -size), groups: s.groups.slice(0, -1), redo: [...s.redo, s.ops.slice(-size)] };
    }),
  redoOp: () =>
    set((s) => {
      const group = s.redo.at(-1);
      if (!group) return s;
      return { ...invalidate(s), ops: [...s.ops, ...group], groups: [...s.groups, group.length], redo: s.redo.slice(0, -1) };
    }),
  setResult: (result, revision) => set((s) => revision === s.revision ? { result, resultRevision: revision } : s),
  setAnalyzing: (analyzing) => set({ analyzing }),
  setError: (error) => set((s) => ({ error, ...(error ? { confirmed: null, confirmationInvalidated: s.confirmationInvalidated || s.confirmed !== null } : {}) })),
  select: (selectedId) => set({ selectedId }),
  confirm: (confirmed) => set((s) => {
    if (confirmed && (!canConfirm(s) || confirmed.contentId !== s.result?.contentId || confirmed.masked !== s.result.masked || confirmed.destinationKey !== destinationKey(s.destination))) return s;
    return { confirmed, confirmationInvalidated: false };
  }),
  setDestination: (destination) => set((s) => ({ destination, confirmed: null, confirmationInvalidated: s.confirmationInvalidated || s.confirmed !== null })),
  setAnswer: (id, a) => set((s) => ({ ...invalidate(s), answers: { ...s.answers, [id]: a } })),
  setConditions: (conditions) => set({ conditions }),
  setNerStatus: (nerStatus) => set({ nerStatus }),
  setNanoStatus: (nanoStatus) => set({ nanoStatus }),
  setNanoProgress: (nanoProgress) => set({ nanoProgress }),
  setNotice: (notice) => set({ notice }),
  policyChanged: () => set((s) => ({ ...invalidate(s), notice: '組織ポリシーが更新されました' })),
  reset: () => {
    set((s) => ({ ...initial, revision: s.revision + 1, sessionId: s.sessionId + 1, prefs: s.prefs, nerStatus: s.nerStatus, nanoStatus: s.nanoStatus }));
    clearAnalysisSession();
    void clearPendingText();
  },
}));

export function settingsFrom(prefs: Prefs, customTerms: Settings['customTerms']): Settings {
  return {
    stage: prefs.stage,
    purpose: prefs.purpose,
    keep: prefs.keep,
    profile: ['rule', ...(prefs.useNer ? (['ner'] as const) : []), ...(prefs.useNano ? (['nano'] as const) : [])],
    customTerms,
    includeHistory: false,
  };
}

/** 出力してよいか。確認済みの版と、現在の版・送信先が一致し、止める理由がないときだけ */
export function canConfirm(s: State): boolean {
  if (!s.result || s.analyzing || s.error || s.resultRevision !== s.revision || s.result.blockers.length > 0) return false;
  const policy = s.result.policy;
  if (policy.status === 'error') return false;
  return !(s.destination.kind === 'insert' && policy.status === 'active' && policy.allowedOrigins !== undefined && !policy.allowedOrigins.includes(s.destination.origin));
}

export function canOutput(s: State): boolean {
  if (!canConfirm(s) || !s.result || !s.confirmed) return false;
  return s.confirmed.contentId === s.result.contentId && s.confirmed.masked === s.result.masked &&
    s.confirmed.destinationKey === destinationKey(s.destination);
}
