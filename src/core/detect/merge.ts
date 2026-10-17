import type { Category, Certainty, Evidence, SensitiveKind, Source, Span, SpanTier } from '../model/types';
import { TIER } from '../model/types';

export type MergedSpan = {
  start: number;
  end: number;
  categories: Category[];
  sources: Source[];
  evidence: Evidence[];
  certainty: Certainty;
  tier: SpanTier;
  sensitiveKind?: SensitiveKind;
  forcedText?: string;
};

const CERTAINTY_RANK: Record<Certainty, number> = { 確定: 0, 推定: 1, 要確認: 2 };

/** 範囲外・負・幅ゼロ・非整数の span は黙って捨てる（ARCHITECTURE.md §5-1） */
export function sanitizeSpans(spans: Span[], textLength: number): Span[] {
  return spans.filter(
    (s) =>
      Number.isInteger(s.start) &&
      Number.isInteger(s.end) &&
      s.start >= 0 &&
      s.end <= textLength &&
      s.end > s.start,
  );
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function uniqEvidence(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return items.filter((e) => {
    const key = `${e.kind}:${e.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function combine(a: MergedSpan, b: MergedSpan): MergedSpan {
  const forcedText = a.forcedText ?? b.forcedText;
  const sensitiveKind = a.sensitiveKind ?? b.sensitiveKind;
  return {
    start: a.start,
    end: a.end,
    categories: uniq([...a.categories, ...b.categories]),
    sources: uniq([...a.sources, ...b.sources]),
    evidence: uniqEvidence([...a.evidence, ...b.evidence]),
    certainty: CERTAINTY_RANK[a.certainty] <= CERTAINTY_RANK[b.certainty] ? a.certainty : b.certainty,
    tier: Math.min(a.tier, b.tier) as SpanTier,
    ...(sensitiveKind ? { sensitiveKind } : {}),
    ...(forcedText ? { forcedText } : {}),
  };
}

function toMerged(s: Span): MergedSpan {
  return {
    start: s.start,
    end: s.end,
    categories: [s.category],
    sources: [s.source],
    evidence: s.evidence,
    certainty: s.certainty,
    tier: s.tier,
    ...(s.sensitiveKind ? { sensitiveKind: s.sensitiveKind } : {}),
    ...(s.forcedText ? { forcedText: s.forcedText } : {}),
  };
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
const contains = (outer: { start: number; end: number }, inner: { start: number; end: number }) =>
  outer.start <= inner.start && inner.end <= outer.end;

/**
 * 全エンジンの span を統合する（ARCHITECTURE.md §5-2）。
 * 1. 同じ範囲は1候補にまとめ、分類を並べる
 * 2. 重なりは優先順位（tier）の高い方を採る
 * 3. ただしヒューリスティック以下の span を完全に含む下位の span は、それを置き換えてよい
 *    （部分一致は無一致より悪い。モデルの正しい全体検出を潰さないため）
 */
export function mergeSpans(spans: Span[], textLength: number): MergedSpan[] {
  const byRange = new Map<string, MergedSpan>();
  for (const s of sanitizeSpans(spans, textLength)) {
    const key = `${s.start}:${s.end}`;
    const m = toMerged(s);
    const prev = byRange.get(key);
    byRange.set(key, prev ? combine(prev, m) : m);
  }

  const ordered = [...byRange.values()].sort(
    (a, b) => a.tier - b.tier || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );

  let accepted: MergedSpan[] = [];
  for (const span of ordered) {
    const hits = accepted.filter((a) => overlaps(a, span));
    if (hits.length === 0) {
      accepted.push(span);
      continue;
    }
    const replaceable = hits.every((h) => h.tier >= TIER.heuristicRule && contains(span, h) && (h.end - h.start < span.end - span.start));
    if (replaceable) {
      accepted = accepted.filter((a) => !hits.includes(a));
      accepted.push(hits.reduce((acc, h) => ({ ...combine(acc, h), start: acc.start, end: acc.end }), span));
    }
  }
  return accepted.sort((a, b) => a.start - b.start);
}
