import type { Category, Span } from '../model/types';
import { TIER } from '../model/types';
import type { MergedSpan } from './merge';
import { normalizeForDetection } from './normalize';

const PROPAGATE: Category[] = ['personName', 'orgName', 'store'];
const HAN = /\p{Script=Han}/u;

/**
 * 一度検出した氏名・組織名・店舗名を、文中の他の出現にも広げる。
 * 署名の「佐藤花子」のように、敬称がなく規則では拾えない箇所の漏れを塞ぐ（確定的な後処理）。
 * 漢字3〜4文字の氏名は、先頭2文字（名字）が単独で現れた箇所も候補にする。
 */
export function propagateMentions(merged: MergedSpan[], text: string): Span[] {
  const norm = normalizeForDetection(text);
  const covered = (s: number, e: number) => merged.some((m) => m.start < e && s < m.end);
  const out: Span[] = [];
  const seen = new Set<string>();
  for (const m of merged) {
    const category = PROPAGATE.find((c) => m.categories.includes(c));
    if (!category) continue;
    const value = norm.slice(m.start, m.end).replace(/[（(][^）)]*[）)]/gu, '').trim();
    const needles: { needle: string; detail: string; surname: boolean }[] = [];
    if (value.length >= 2) needles.push({ needle: value, detail: '同じ語が他の箇所で検出されています', surname: false });
    const compact = value.replace(/\s/g, '');
    if (category === 'personName' && compact.length >= 3 && compact.length <= 4 && [...compact].every((ch) => HAN.test(ch))) {
      needles.push({ needle: compact.slice(0, 2), detail: '同じ名字の人物が他の箇所で検出されています', surname: true });
    }
    for (const { needle, detail, surname } of needles) {
      const key = `${category}|${needle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let from = 0;
      for (;;) {
        const at = norm.indexOf(needle, from);
        if (at < 0) break;
        from = at + needle.length;
        const end = at + needle.length;
        if (covered(at, end)) continue;
        // 漢字の語の途中（「佐藤製薬」など）には広げない
        const prev = norm[at - 1] ?? '';
        const next = norm[end] ?? '';
        if (HAN.test(prev) || HAN.test(next)) continue;
        out.push({
          start: at,
          end,
          category,
          source: m.sources.includes('ner') ? 'ner' : 'rule',
          certainty: surname ? '要確認' : '推定',
          evidence: [{ kind: 'context', detail }],
          tier: TIER.heuristicRule,
        });
      }
    }
  }
  return out;
}
