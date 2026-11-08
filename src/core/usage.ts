import { BLOCKER_KINDS, MAX_COUNT, type UsageCore, type UsageDestination } from '../../shared/usage-event';
import { primaryCategory } from './model/categories';
import type { AnalysisResult, Category, Purpose, Stage } from './model/types';
import { riskRank } from './risk/combination';

// 解析結果から、組織へ送る利用記録の中身を作る（SERVER_DESIGN.md §1-2）。
// 候補の文字列・加工後の文字列・対応表は読まない。種類ごとの件数と、決められた値だけを取り出す。

/** 記録に残す停止理由。入力中に必ず出る「空の文章」などは数えない */
export const REPORTED_BLOCKERS = ['credential', 'prohibited', 'policy'] as const satisfies readonly (typeof BLOCKER_KINDS)[number][];

const cap = (n: number) => Math.min(n, MAX_COUNT);

export function summarizeUsage(
  result: Pick<AnalysisResult, 'candidates' | 'risks' | 'blockers' | 'engines'>,
  input: { kind: 'output' | 'blocked'; stage: Stage; purpose: Purpose; manualOps: number; destination: UsageDestination | null },
): UsageCore {
  const masked: Partial<Record<Category, number>> = {};
  const kept: Partial<Record<Category, number>> = {};
  for (const c of result.candidates) {
    const into = c.action.kind === 'keep' ? kept : masked;
    const category = primaryCategory(c.categories);
    into[category] = cap((into[category] ?? 0) + 1);
  }
  const top = result.risks.reduce<AnalysisResult['risks'][number]['level'] | null>(
    (acc, r) => (acc === null || riskRank(r.level) > riskRank(acc) ? r.level : acc),
    null,
  );
  const engine = (id: 'ner' | 'nano') => {
    const status = result.engines.find((e) => e.engine === id)?.status ?? 'skipped';
    return status === 'ok' || status === 'skipped' ? status : 'failed';
  };
  const blockers = input.kind === 'blocked'
    ? [...new Set(result.blockers.map((b) => b.kind))].filter((k): k is (typeof REPORTED_BLOCKERS)[number] => (REPORTED_BLOCKERS as readonly string[]).includes(k))
    : [];
  return {
    kind: input.kind,
    stage: input.stage,
    purpose: input.purpose,
    destination: input.kind === 'output' ? input.destination : null,
    masked,
    kept,
    manualOps: cap(input.manualOps),
    riskLevel: top,
    blockers,
    engines: { ner: engine('ner'), nano: engine('nano') },
  };
}

/** 出力先を記録の値に直す。対応サイト以外の挿入先は記録しない */
export function usageDestination(d: { kind: 'copy' } | { kind: 'file' } | { kind: 'insert'; siteId: string }): UsageDestination | null {
  if (d.kind !== 'insert') return d.kind;
  return d.siteId === 'gemini' || d.siteId === 'chatgpt' || d.siteId === 'claude' ? `insert:${d.siteId}` : null;
}
