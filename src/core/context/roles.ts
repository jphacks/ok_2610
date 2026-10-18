import type { Certainty, Evidence, Role } from '../model/types';
import { DATE_ROLE_CUES, DATE_ROLE_SUFFIX, EXAMPLE_CUES } from '../detect/vocab';

const BEFORE_WINDOW = 20;
const AFTER_WINDOW = 30;
const SENTENCE_BREAK = /[。！？!?\n]/u;

type RoleCue = { role: Exclude<Role, 'unknownDate' | 'example' | 'quote'>; re: RegExp };

const CUES: RoleCue[] = [
  { role: 'birthDate', re: new RegExp(DATE_ROLE_CUES.birthDate, 'gu') },
  { role: 'sensitiveDate', re: new RegExp(DATE_ROLE_CUES.sensitiveDate, 'gu') },
  { role: 'businessDate', re: new RegExp(DATE_ROLE_CUES.businessDate, 'gu') },
];

/** 同じ文の中だけを見る */
function sentenceWindow(text: string, start: number, end: number): { before: string; after: string } {
  let from = Math.max(0, start - BEFORE_WINDOW);
  const beforeRaw = text.slice(from, start);
  const lastBreak = Math.max(...[...beforeRaw.matchAll(/[。！？!?\n]/gu)].map((m) => m.index ?? -1), -1);
  if (lastBreak >= 0) from += lastBreak + 1;
  const afterRaw = text.slice(end, end + AFTER_WINDOW);
  const cut = afterRaw.search(SENTENCE_BREAK);
  return { before: text.slice(from, start), after: cut >= 0 ? afterRaw.slice(0, cut) : afterRaw };
}

export type RoleResult = { role: Role; certainty: Certainty; evidence: Evidence[] };

/**
 * 日付の役割を周辺語で決める（FR-06）。最も近い手がかりを採る。
 * 手がかりがなければ「要確認」とし、黙って断定しない。
 */
export function classifyDateRole(text: string, start: number, end: number): RoleResult {
  const { before, after } = sentenceWindow(text, start, end);
  let best: { role: RoleCue['role']; distance: number; word: string } | null = null;
  for (const [role, re] of Object.entries(DATE_ROLE_SUFFIX) as [RoleCue['role'], RegExp][]) {
    const m = re.exec(after);
    if (m) best = { role, distance: 0, word: m[0].trim() };
  }
  for (const cue of CUES) {
    for (const m of before.matchAll(cue.re)) {
      const distance = before.length - ((m.index ?? 0) + m[0].length);
      if (!best || distance < best.distance) best = { role: cue.role, distance, word: m[0] };
    }
    for (const m of after.matchAll(cue.re)) {
      const distance = m.index ?? 0;
      if (!best || distance < best.distance) best = { role: cue.role, distance, word: m[0] };
    }
  }
  if (!best) {
    return {
      role: 'unknownDate',
      certainty: '要確認',
      evidence: [{ kind: 'context', detail: '日付の役割を示す語が近くに見つからない' }],
    };
  }
  const labelLike = /[:：]\s*$/u.test(before) || best.distance <= 2;
  return {
    role: best.role,
    certainty: labelLike ? '確定' : '推定',
    evidence: [{ kind: 'context', detail: `近くに「${best.word}」` }],
  };
}

const EXAMPLE_RE = new RegExp(EXAMPLE_CUES, 'u');

/** 架空例・仮定の話の中にあるか（FR-03, FR-06）。断定はせず注記に使う */
export function isInExample(text: string, start: number): boolean {
  const { before } = sentenceWindow(text, start, start);
  return EXAMPLE_RE.test(before);
}
