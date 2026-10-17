import { create } from 'zustand';
import type { Answer, ConditionsResult } from '../core/conditions';
import type { AnalysisResult, ManualOp, Settings } from '../core/model/types';
import type { PolicySummary } from '../worker/protocol';
import type { NanoAvailability } from '../engines/nano';
import { DEFAULT_PREFS, type Prefs } from '../infra/storage';

// サイドパネルの状態。原文・対応表・解析結果はメモリにだけ置き、パネルを閉じれば消える。

export type Destination = { kind: 'copy' } | { kind: 'insert'; tabId: number; origin: string; siteId: string; siteName: string };

export const destinationKey = (d: Destination) => (d.kind === 'copy' ? 'copy' : `insert:${d.tabId}:${d.origin}`);

export type Confirmed = { contentId: string; destinationKey: string; masked: string };

type State = {
  text: string;
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
  setPrefs: (patch: Partial<Prefs>) => void;
  addOp: (op: ManualOp) => void;
  addOps: (ops: ManualOp[]) => void;
  undo: () => void;
  redoOp: () => void;
  setResult: (r: State['result']) => void;
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
  /** 「終了して削除」: 原文・対応表・手動操作・確認状態をすべて消す */
  reset: () => void;
};

const initial: State = {
  text: '',
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

export const useStore = create<State & Actions>((set) => ({
  ...initial,
  // 本文が変われば手動操作の位置は意味を失うので消す
  setText: (text) => set({ text, ops: [], groups: [], redo: [], selectedId: null }),
  setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
  addOp: (op) => set((s) => ({ ops: [...s.ops, op], groups: [...s.groups, 1], redo: [] })),
  addOps: (ops) => set((s) => (ops.length ? { ops: [...s.ops, ...ops], groups: [...s.groups, ops.length], redo: [] } : s)),
  undo: () =>
    set((s) => {
      const size = s.groups.at(-1);
      if (!size) return s;
      return { ops: s.ops.slice(0, -size), groups: s.groups.slice(0, -1), redo: [...s.redo, s.ops.slice(-size)] };
    }),
  redoOp: () =>
    set((s) => {
      const group = s.redo.at(-1);
      if (!group) return s;
      return { ops: [...s.ops, ...group], groups: [...s.groups, group.length], redo: s.redo.slice(0, -1) };
    }),
  setResult: (result) => set({ result }),
  setAnalyzing: (analyzing) => set({ analyzing }),
  setError: (error) => set({ error }),
  select: (selectedId) => set({ selectedId }),
  confirm: (confirmed) => set({ confirmed }),
  setDestination: (destination) => set({ destination }),
  setAnswer: (id, a) => set((s) => ({ answers: { ...s.answers, [id]: a } })),
  setConditions: (conditions) => set({ conditions }),
  setNerStatus: (nerStatus) => set({ nerStatus }),
  setNanoStatus: (nanoStatus) => set({ nanoStatus }),
  setNanoProgress: (nanoProgress) => set({ nanoProgress }),
  setNotice: (notice) => set({ notice }),
  reset: () => set((s) => ({ ...initial, prefs: s.prefs, nerStatus: s.nerStatus, nanoStatus: s.nanoStatus })),
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
export function canOutput(s: Pick<State, 'result' | 'confirmed' | 'destination' | 'analyzing'>): boolean {
  if (!s.result || !s.confirmed || s.analyzing) return false;
  if (s.result.blockers.length > 0) return false;
  return s.confirmed.contentId === s.result.contentId && s.confirmed.destinationKey === destinationKey(s.destination);
}
