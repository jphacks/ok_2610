import type { Category, Span } from '../core/model/types';
import { TIER } from '../core/model/types';
import { NON_NAME_BEFORE_HONORIFIC } from '../core/detect/vocab';

// NER の出力を原文上の span に変換する純粋関数（tests/unit/ner-post.test.ts で固定）。
// Transformers.js の token-classification は文字位置を返さないため、トークン列を原文に突き合わせて復元する。

export type NerToken = { entity: string; score: number; index: number; word: string };

const LABEL_TO_CATEGORY: Record<string, Category> = {
  PER: 'personName',
  ORG: 'orgName',
  'ORG-P': 'orgName',
  'ORG-O': 'orgName',
  LOC: 'place',
  INS: 'store',
};

const MIN_SCORE = 0.6;
const NON_ORG_WORDS = new Set([
  'ネイビー', 'グレー', 'ベージュ', 'ブラック', 'ホワイト', 'シルバー', 'ゴールド', 'レッド', 'ブルー', 'グリーン', 'ピンク', 'ブラウン', 'イエロー',
  'オレンジ', 'パープル', 'カーキ', 'アイボリー',
]);
const LEADING_TRIM = /^[\s、。,.・の]+/u;
const TRAILING_TRIM = /(?:[\s、。,.・]|さん|様|さま|氏|殿|くん|君|ちゃん|先生|の|は|が|を|に|で|と|へ|も)+$/u;

/** 原文の各文字を NFKC にした文字列と、正規化後の位置 → 原文の位置の対応表 */
function nfkcWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const n = (text[i] ?? '').normalize('NFKC');
    for (let k = 0; k < n.length; k++) map.push(i);
    norm += n;
  }
  return { norm, map };
}

type Aligned = { start: number; end: number; label: string; score: number; index: number };

/** トークンを順に原文へ突き合わせる。見つからないトークンは飛ばす（位置を推測しない） */
export function alignTokens(text: string, tokens: NerToken[]): Aligned[] {
  const { norm, map } = nfkcWithMap(text);
  const out: Aligned[] = [];
  let cursor = 0;
  for (const t of [...tokens].sort((a, b) => a.index - b.index)) {
    const piece = t.word.replace(/^▁/u, '').normalize('NFKC');
    if (!piece) continue;
    const at = norm.indexOf(piece, cursor);
    if (at < 0 || at - cursor > 8) continue;
    const start = map[at];
    const last = map[at + piece.length - 1];
    if (start === undefined || last === undefined) continue;
    out.push({ start, end: last + 1, label: t.entity, score: t.score, index: t.index });
    cursor = at + piece.length;
  }
  return out;
}

/** 同じラベルが連続するトークンを1つの固有表現にまとめ、敬称や助詞を外して span にする */
export function entitiesToSpans(text: string, tokens: NerToken[], offset = 0): Span[] {
  const aligned = alignTokens(text, tokens).filter((a) => a.label !== 'O');
  const groups: Aligned[][] = [];
  for (const a of aligned) {
    const prev = groups.at(-1)?.at(-1);
    if (prev && prev.label === a.label && a.index === prev.index + 1 && !/\s/u.test(text.slice(prev.end, a.start))) {
      groups.at(-1)?.push(a);
    } else {
      groups.push([a]);
    }
  }
  // 空白で区切られた姓と名（「ササキ ユウコ」「森 蓮」）は、どちらも確信度の足りる人名なら1つの人名にする
  const confident = (g: Aligned[]) => g.reduce((s, a) => s + a.score, 0) / g.length >= MIN_SCORE;
  for (let i = groups.length - 1; i > 0; i--) {
    const prev = groups[i - 1]!;
    const cur = groups[i]!;
    const gap = text.slice(prev.at(-1)!.end, cur[0]!.start);
    if (prev[0]!.label === 'PER' && cur[0]!.label === 'PER' && /^[^\S\n]$/u.test(gap) && confident(prev) && confident(cur)) {
      groups.splice(i - 1, 2, [...prev, ...cur]);
    }
  }
  const spans: Span[] = [];
  for (const g of groups) {
    const first = g[0];
    const last = g.at(-1);
    if (!first || !last) continue;
    const category = LABEL_TO_CATEGORY[first.label];
    if (!category) continue;
    if (!confident(g)) continue;
    const score = g.reduce((s, a) => s + a.score, 0) / g.length;
    let start = first.start;
    let end = last.end;
    const value = text.slice(start, end);
    const lead = LEADING_TRIM.exec(value)?.[0].length ?? 0;
    const trail = TRAILING_TRIM.exec(value.slice(lead))?.[0].length ?? 0;
    start += lead;
    end -= trail;
    if (end - start < 1 || (category !== 'personName' && end - start < 2)) continue;
    // 「御中」「各位」などを人名と判定することがあるため、規則と同じ語彙で外す
    const found = text.slice(start, end);
    if (category === 'personName' && NON_NAME_BEFORE_HONORIFIC.has(found.replace(/\s/gu, ''))) continue;
    // 社員番号・ユーザーIDなどの英数字（S58330・kenta0412）を人名と判定することがある。隠す必要はあるのでIDとして扱う
    const idLike = category === 'personName' && /^[A-Za-z0-9._-]+$/u.test(found) && /\d/u.test(found);
    // 色の名前（ネイビー・グレー）を組織と判定することがある
    if (category === 'orgName' && NON_ORG_WORDS.has(found)) continue;
    spans.push({
      start: start + offset,
      end: end + offset,
      category: idLike ? 'customerId' : category,
      source: 'ner',
      certainty: '推定',
      evidence: [{ kind: 'model', detail: `NERモデルが${first.label}と判定（確信度 ${score.toFixed(2)}）` }],
      tier: TIER.ner,
    });
  }
  return spans;
}

/** モデルの入力長に収まるよう、文の区切りで分割する */
export function chunkText(text: string, maxChars = 300): { offset: number; text: string }[] {
  const chunks: { offset: number; text: string }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('\n'), slice.lastIndexOf('！'), slice.lastIndexOf('？'));
      if (cut > maxChars / 3) end = start + cut + 1;
    }
    chunks.push({ offset: start, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}
