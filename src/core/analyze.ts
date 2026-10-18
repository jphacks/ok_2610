import { classifyDateRole, isInExample } from './context/roles';
import { makeLabelAllocator, resolveEntities } from './context/entities';
import { detectPatterns, detectTerms } from './detect/dictionary';
import { mergeSpans, type MergedSpan } from './detect/merge';
import { propagateMentions } from './detect/propagate';
import { detectRules, RULE_ENGINE_VERSION } from './detect/rules';
import { explain } from './explain/explain';
import { CATEGORY_INFO } from './model/categories';
import type {
  Action,
  AnalysisResult,
  Blocker,
  Candidate,
  Coverage,
  EngineId,
  EngineStatus,
  ManualOp,
  OpIssue,
  RiskFinding,
  Role,
  Settings,
  Span,
  Stage,
  StageRecommendation,
} from './model/types';
import { TIER } from './model/types';
import { lockedCategories, policyVersion, type ResolvedPolicy } from './policy';
import type { ConditionsResult } from './conditions';
import { recheck } from './recheck';
import { computeContentId } from './review';
import { evaluateCombination, planRiskReduction, riskRank } from './risk/combination';
import { prefectureOf } from './transform/generalize';
import { render } from './transform/render';
import { actionStrength, decideAction, maxStage } from './transform/stages';

export const MAX_CHARS = 30000;

export type EngineOutput = {
  engine: Exclude<EngineId, 'rule'>;
  status: 'ok' | 'unavailable' | 'failed';
  reason?: string;
  ms: number;
  spans: Span[];
  version?: string;
};

export type AnalyzeInput = {
  text: string;
  settings: Settings;
  ops: ManualOp[];
  engineOutputs: EngineOutput[];
  policy: ResolvedPolicy;
  conditions: ConditionsResult;
};

type Base = Omit<Candidate, 'action' | 'recommended' | 'output' | 'manual'> & { manual: boolean };

const rangeKey = (s: { start: number; end: number }) => `${s.start}:${s.end}`;

function effectiveProfile(settings: Settings, policy: ResolvedPolicy): EngineId[] {
  const set = new Set<EngineId>(['rule', ...settings.profile]);
  if (policy.status === 'active') for (const e of policy.minProfile) set.add(e);
  return [...set];
}

/** 構造を変える手動操作（追加・範囲調整・分類訂正）を、自動の統合結果に重ねる */
function applyStructuralOps(merged: MergedSpan[], ops: ManualOp[], text: string, issues: OpIssue[]): MergedSpan[] {
  let spans = [...merged];
  ops.forEach((op, opIndex) => {
    if (op.kind === 'add') {
      if (op.end <= op.start || op.start < 0 || op.end > text.length) {
        issues.push({ opIndex, kind: 'conflict', reason: '追加した範囲が文章の外にあります。' });
        return;
      }
      spans = spans.filter((s) => !(s.start < op.end && op.start < s.end));
      spans.push({
        start: op.start,
        end: op.end,
        categories: [op.category],
        sources: ['manual'],
        evidence: [{ kind: 'manual', detail: '利用者が手動で追加' }],
        certainty: '確定',
        tier: TIER.certainRule,
      });
    } else if (op.kind === 'resize' || op.kind === 'setCategory') {
      const target = spans.find((s) => s.start === op.start && s.end === op.end);
      if (!target) {
        issues.push({ opIndex, kind: 'conflict', reason: '対象の候補が見つかりません。自動検出の結果が変わった可能性があります。' });
        return;
      }
      if (op.kind === 'resize') {
        if (op.newEnd <= op.newStart || op.newStart < 0 || op.newEnd > text.length) {
          issues.push({ opIndex, kind: 'conflict', reason: '調整後の範囲が正しくありません。' });
          return;
        }
        spans = spans.filter((s) => s === target || !(s.start < op.newEnd && op.newStart < s.end));
        Object.assign(target, { start: op.newStart, end: op.newEnd });
      } else {
        Object.assign(target, { categories: [op.category], sources: [...new Set([...target.sources, 'manual' as const])] });
      }
    }
  });
  return spans.sort((a, b) => a.start - b.start);
}

function buildBase(spans: MergedSpan[], text: string, nanoRoles: Map<string, Role>): Base[] {
  return spans.map((s) => {
    const base: Base = {
      id: `c${s.start}-${s.end}`,
      start: s.start,
      end: s.end,
      text: text.slice(s.start, s.end),
      categories: s.categories,
      sources: s.sources,
      evidence: s.evidence,
      certainty: s.certainty,
      manual: s.sources.includes('manual'),
      ...(s.sensitiveKind ? { sensitiveKind: s.sensitiveKind } : {}),
      ...(s.forcedText !== undefined ? { forcedText: s.forcedText } : {}),
    };
    if (s.categories.includes('date')) {
      const r = classifyDateRole(text, s.start, s.end);
      const hint = nanoRoles.get(rangeKey(s));
      if (r.role === 'unknownDate' && hint) {
        base.role = hint;
        base.certainty = '推定';
        base.sources = [...new Set([...base.sources, 'nano' as const])];
        base.evidence = [...base.evidence, { kind: 'model', detail: 'AIが文脈から推定した役割' }];
      } else {
        base.role = r.role;
        base.certainty = r.certainty === '要確認' ? '要確認' : base.certainty;
        base.evidence = [...base.evidence, ...r.evidence];
      }
    }
    return base;
  });
}

type Decided = { candidates: Candidate[]; issues: OpIssue[] };

/** 段階ごとの処理を決め、手動の上書き（解除・処理変更）を重ねる */
function decideAll(bases: Base[], stage: Stage, input: AnalyzeInput, entityOf: Map<string, string>): Decided {
  const { settings, ops, policy } = input;
  const locked = new Set(lockedCategories(policy));
  const issues: OpIssue[] = [];
  const candidates: Candidate[] = bases.map((b) => {
    const entityId = entityOf.get(b.id);
    const recommended = decideAction({
      categories: b.categories,
      ...(b.role ? { role: b.role } : {}),
      ...(b.forcedText !== undefined ? { forcedText: b.forcedText } : {}),
      stage,
      purpose: settings.purpose,
      keepFlags: settings.keep,
      hasPrefecture: prefectureOf(b.text) !== undefined,
    });
    return { ...b, ...(entityId ? { entityId } : {}), action: recommended, recommended, output: b.text };
  });
  const byRange = new Map(candidates.map((c) => [rangeKey(c), c]));
  ops.forEach((op, opIndex) => {
    if (op.kind !== 'release' && op.kind !== 'setAction') return;
    const c = byRange.get(rangeKey(op));
    if (!c) {
      issues.push({ opIndex, kind: 'conflict', reason: '対象の候補が見つかりません。自動検出の結果が変わった可能性があります。' });
      return;
    }
    const action: Action = op.kind === 'release' ? { kind: 'keep' } : op.action;
    const lockedHit = c.categories.find((cat) => locked.has(cat));
    if (lockedHit && actionStrength(action) < actionStrength(c.recommended)) {
      issues.push({
        opIndex,
        kind: 'rejected',
        reason: `${CATEGORY_INFO[lockedHit].label}は${lockedHit === 'credential' ? '常に' : '組織ポリシーにより'}解除できません。`,
      });
      return;
    }
    c.action = action;
    c.manual = true;
  });
  return { candidates, issues };
}

function recommendStage(levels: Record<Stage, RiskFinding[]>, current: Stage): StageRecommendation {
  const levelOf = (s: Stage) => levels[s][0]?.level ?? 'なし';
  if (levelOf(current) === '評価不能') {
    return { stage: current, reasons: ['検出の一部が失敗しているため、おすすめ段階を出せません。'] };
  }
  if (riskRank(levelOf('A')) === 0) {
    const reasons = ['加工後に残る組合せの手がかりが少ないため、意味を最も保てる A でも足りる可能性があります。'];
    if (current !== 'A') reasons.push(`現在は段階 ${current} です。`);
    return { stage: 'A', reasons };
  }
  const reasons = [`段階 A では組合せの手がかりが残ります（注意度: ${levelOf('A')}）。属性も一般化する B をおすすめします。`];
  if (riskRank(levelOf('B')) > 0) {
    reasons.push(`段階 B でも手がかりが残ります（注意度: ${levelOf('B')}）。「対策をまとめて適用」で、原因になっている項目だけを加工できます。`);
  }
  return { stage: 'B', reasons };
}

/** 全工程（検出 → 文脈 → 同一対象 → 段階 → 組合せ → 理由 → 再検査 → 確認単位）を実行する */
export async function analyze(input: AnalyzeInput): Promise<AnalysisResult> {
  const { text, settings, ops, engineOutputs, policy, conditions } = input;
  const profile = effectiveProfile(settings, policy);
  const stage = policy.status === 'active' ? maxStage(settings.stage, policy.minStage) : settings.stage;
  const blockers: Blocker[] = [];
  const limit = Math.min(text.length, MAX_CHARS);
  const scope = text.slice(0, limit);

  const engines: EngineStatus[] = [{ engine: 'rule', status: 'ok', ms: 0, spanCount: 0 }];
  const spans: Span[] = [];
  const ruleSpans = detectRules(scope);
  engines[0]!.spanCount = ruleSpans.length;
  spans.push(...ruleSpans);
  spans.push(...detectTerms(scope, settings.customTerms, 'custom', TIER.customDictionary));
  if (policy.status === 'active') {
    spans.push(...detectTerms(scope, policy.orgTerms, 'orgTerm', TIER.orgDictionary));
    spans.push(...detectPatterns(scope, policy.patterns, TIER.orgDictionary));
  }

  let analysisFailed = false;
  const nanoRoles = new Map<string, Role>();
  for (const id of ['ner', 'nano'] as const) {
    const out = engineOutputs.find((o) => o.engine === id);
    if (!profile.includes(id)) {
      engines.push({ engine: id, status: 'skipped', ms: 0, spanCount: 0 });
      continue;
    }
    if (!out || out.status !== 'ok') {
      analysisFailed = true;
      const reason = out?.reason ?? '結果がありません';
      engines.push({ engine: id, status: out?.status ?? 'failed', reason, ms: out?.ms ?? 0, spanCount: 0 });
      blockers.push({ kind: 'engineFailed', message: `${id === 'ner' ? 'NER' : 'Gemini Nano'} が使えません（${reason}）。再試行するか、検査の設定から外してください。` });
      continue;
    }
    const inScope = out.spans.filter((s) => s.end <= limit);
    for (const s of inScope) if (s.category === 'date' && s.role) nanoRoles.set(rangeKey(s), s.role);
    // 日付の役割のヒントは範囲を増やさない（規則の日付に重ねるだけ）
    spans.push(...inScope.filter((s) => !(s.category === 'date' && s.role)));
    engines.push({ engine: id, status: 'ok', ms: out.ms, spanCount: inScope.length });
  }

  const opIssues: OpIssue[] = [];
  const firstPass = mergeSpans(spans, scope.length);
  const propagated = propagateMentions(firstPass, scope);
  const autoMerged = propagated.length > 0 ? mergeSpans([...spans, ...propagated], scope.length) : firstPass;
  const merged = applyStructuralOps(autoMerged, ops, scope, opIssues);
  const bases = buildBase(merged, text, nanoRoles);

  const allocate = makeLabelAllocator(text);
  const { entities, entityOf, ambiguous } = resolveEntities(bases, ops, allocate);

  const current = decideAll(bases, stage, input, entityOf);
  opIssues.push(...current.issues);
  const rendered = render(text, current.candidates, entities, allocate);
  for (const c of current.candidates) c.output = rendered.outputs.get(c.id) ?? c.text;

  const risks = evaluateCombination({ candidates: current.candidates, analysisFailed });
  const perStage = {} as Record<Stage, RiskFinding[]>;
  for (const s of ['A', 'B'] as Stage[]) {
    perStage[s] = s === stage ? risks : evaluateCombination({ candidates: decideAll(bases, s, input, entityOf).candidates, analysisFailed });
  }
  const recommendation = recommendStage(perStage, stage);
  const riskPlan = analysisFailed ? null : planRiskReduction(current.candidates);

  const explanations: AnalysisResult['explanations'] = {};
  for (const c of current.candidates) {
    explanations[c.id] = explain(c, { ambiguousEntity: ambiguous.has(c.id), inExample: isInExample(text, c.start), stage });
  }

  const recheckFindings = recheck({
    masked: rendered.masked,
    candidates: current.candidates,
    outputs: rendered.outputs,
    generatedLabels: Object.keys(rendered.restoreMap),
    orgTerms: policy.status === 'active' ? policy.orgTerms : [],
    customTerms: settings.customTerms,
  });

  const coverage: Coverage[] = [{ start: 0, end: limit, status: analysisFailed ? '解析不能' : '検査済', ...(analysisFailed ? { reason: '検出の一部が失敗しました' } : {}) }];
  if (limit < text.length) {
    coverage.push({ start: limit, end: text.length, status: '対象外', reason: `${MAX_CHARS.toLocaleString()}文字を超えた部分は検査していません` });
    blockers.push({ kind: 'uncovered', message: `${MAX_CHARS.toLocaleString()}文字を超えた部分は検査していません。文章を分けて解析してください。` });
  }

  if (!text.trim()) blockers.push({ kind: 'empty', message: '文章が空です。' });
  if (policy.status === 'error') blockers.push({ kind: 'policy', message: `${policy.reason} 個人設定に切り替えずに停止しています。` });
  for (const c of current.candidates) {
    if (c.categories.includes('credential') && c.action.kind !== 'delete') {
      blockers.push({ kind: 'credential', message: `認証情報「${c.text.slice(0, 4)}…」が残っています。` });
    }
    if (policy.status === 'active' && c.action.kind === 'keep') {
      const hit = c.categories.find((cat) => policy.prohibited.includes(cat));
      if (hit) blockers.push({ kind: 'prohibited', message: `組織ポリシーで禁止された${CATEGORY_INFO[hit].label}が残っています。` });
    }
  }
  for (const f of recheckFindings) if (f.blocking) blockers.push({ kind: 'recheck', message: f.message });
  if (policy.status === 'active' && policy.requireConditions && conditions.status !== 'selfDeclaredOk') {
    blockers.push({ kind: 'conditions', message: '組織ポリシーにより、利用条件の確認が済むまで出力できません。' });
  }

  const contentId = await computeContentId({
    text,
    settings,
    ops,
    policy: policyVersion(policy),
    detectors: {
      rule: RULE_ENGINE_VERSION,
      ...Object.fromEntries(engineOutputs.filter((o) => profile.includes(o.engine)).map((o) => [o.engine, `${o.version ?? '?'}:${o.status}`])),
    },
    engineSpans: engineOutputs.filter((o) => profile.includes(o.engine)).map((o) => o.spans.map((s) => [s.start, s.end, s.category, s.role ?? ''])),
    coverage,
    conditions: conditions.status,
  });

  return {
    text,
    candidates: current.candidates,
    entities,
    risks,
    coverage,
    engines,
    explanations,
    recommendation,
    riskPlan,
    masked: rendered.masked,
    segments: rendered.segments,
    recheck: recheckFindings,
    blockers,
    opIssues,
    contentId,
    restoreMap: rendered.restoreMap,
    generalizedMap: rendered.generalizedMap,
  };
}

