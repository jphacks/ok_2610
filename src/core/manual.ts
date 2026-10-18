import type { Candidate, Category, ManualOp } from './model/types';

type Range = { start: number; end: number };

/**
 * 利用者が見逃しとして指定した語を、手動で加工する操作に直す（FR-19）。
 * anchor（選んだ範囲）は利用者の意思なので必ず含める。ほかの出現箇所は、
 * すでに加工している候補と重なるものを除く（広い候補を狭い範囲で上書きしないため）。
 */
export function manualMaskOps(
  text: string,
  term: string,
  category: Category,
  candidates: Pick<Candidate, 'start' | 'end' | 'text' | 'output'>[],
  { all, anchor }: { all: boolean; anchor?: Range },
): ManualOp[] {
  const ranges: Range[] = [];
  // 入力欄を書き換えて選んだ範囲と食い違ったら、範囲は使わず語で探す
  if (anchor && anchor.end > anchor.start && text.slice(anchor.start, anchor.end) === term) ranges.push(anchor);
  if (term && (all || ranges.length === 0)) {
    const masked = candidates.filter((c) => c.output !== c.text);
    for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) {
      const r = { start: at, end: at + term.length };
      if (ranges.some((x) => x.start < r.end && r.start < x.end)) continue;
      if (masked.some((c) => c.start < r.end && r.start < c.end)) continue;
      ranges.push(r);
      if (!all) break;
    }
  }
  return ranges.sort((a, b) => a.start - b.start).map((r) => ({ kind: 'add', ...r, category }));
}

/** 文章中の出現回数（重ならない数え方） */
export function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  let n = 0;
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) n++;
  return n;
}
