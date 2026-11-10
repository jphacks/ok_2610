import type { CustomTerm, Span, SpanTier } from '../model/types';
import { normalizeForDetection } from './normalize';

/** 英字だけ小文字にする（長さを変えないため toLowerCase は使わない） */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** カスタム辞書の語を完全一致で探す。全角半角と英字の大小は区別しない */
export function detectTerms(text: string, terms: CustomTerm[], tier: SpanTier): Span[] {
  const hay = lowerAscii(normalizeForDetection(text));
  const spans: Span[] = [];
  for (const { term, label } of terms) {
    const needle = lowerAscii(normalizeForDetection(term.trim()));
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      spans.push({
        start: at,
        end: at + needle.length,
        category: 'custom',
        source: 'custom',
        certainty: '確定',
        evidence: [{ kind: 'dictionary', detail: 'カスタム辞書に登録された語' }],
        tier,
        ...(label ? { forcedText: label } : {}),
      });
      from = at + needle.length;
    }
  }
  return spans;
}

/**
 * カスタム辞書のテキストを解析する。1行1語。「語=>置換語」で置換語を指定できる。
 * 「#」で始まる行は注釈。
 */
export function parseCustomTerms(source: string): CustomTerm[] {
  const terms: CustomTerm[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [term, label] = trimmed.split('=>').map((s) => s.trim());
    if (!term) continue;
    terms.push(label ? { term, label } : { term });
  }
  return terms;
}
