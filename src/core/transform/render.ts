import { CATEGORY_INFO, categoryLabel, primaryCategory } from '../model/categories';
import type { Candidate, Entity, OutputSegment } from '../model/types';
import { letterLabel, makeLabelAllocator, mentionKey } from '../context/entities';
import { generalize } from './generalize';

export type RenderResult = {
  masked: string;
  segments: OutputSegment[];
  /** ラベル → 原文（復元用）。一般化・削除したものは含めない */
  restoreMap: Record<string, string>;
  /** 一般化した語 → 原文（復元用）。元の語が1つに決まり、加工後の文章でほかに現れない語だけ */
  generalizedMap: Record<string, string>;
  outputs: Map<string, string>;
};

function partialMask(text: string, visible: number): string {
  let shown = 0;
  return [...text]
    .reverse()
    .map((ch) => {
      if (/[\s\-–—_.@]/u.test(ch)) return ch;
      if (shown < visible) {
        shown++;
        return ch;
      }
      return '*';
    })
    .reverse()
    .join('');
}

/**
 * 候補の処理から加工後の文章を組み立てる。
 * 同じ分類・同じ原文には同じラベルを返す（採番は出現順なので決定的）。
 */
export function render(text: string, candidates: Candidate[], entities: Entity[], allocate: ReturnType<typeof makeLabelAllocator>): RenderResult {
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const categoryLabels = new Map<string, string>();
  const pseudonyms = new Map<string, string>();
  const restoreMap: Record<string, string> = {};
  const outputs = new Map<string, string>();
  /** 一般化した語 → 原文の候補と出現数 */
  const generalized = new Map<string, { originals: Set<string>; count: number }>();

  const sorted = [...candidates].sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    const category = primaryCategory(c.categories);
    const info = CATEGORY_INFO[category];
    let out: string;
    switch (c.action.kind) {
      case 'keep':
        out = c.text;
        break;
      case 'delete':
        out = '';
        break;
      case 'replace':
        out = c.action.text;
        break;
      case 'partialMask':
        out = partialMask(c.text, c.action.visible);
        break;
      case 'pseudonym': {
        const entity = c.entityId ? entityById.get(c.entityId) : undefined;
        if (entity) {
          out = entity.label;
          // 出力に現れるラベルだけを対応表に入れる。一般化で消えた対象のラベルをAIが偶然書いても、原文を戻さない
          restoreMap[out] = entity.canonical;
        } else {
          const key = `${category}|${mentionKey(c.text)}`;
          out = pseudonyms.get(key) ?? allocate(info.pseudonymPrefix ?? categoryLabel(category), (p, n) => `${p}${letterLabel(n)}`);
          pseudonyms.set(key, out);
          restoreMap[out] = c.text;
        }
        break;
      }
      case 'generalize': {
        const g = generalize(c.text, category, c.action.level, c.sensitiveKind);
        if (g !== null) {
          out = g;
          if (g !== c.text) {
            const entry = generalized.get(g) ?? { originals: new Set<string>(), count: 0 };
            entry.originals.add(c.text);
            entry.count++;
            generalized.set(g, entry);
          }
          break;
        }
        out = labelFor(category, c.text);
        break;
      }
      case 'categoryLabel':
        out = labelFor(category, c.text);
        break;
    }
    outputs.set(c.id, out);
  }

  function labelFor(category: Candidate['categories'][number], original: string): string {
    const key = `${category}|${mentionKey(original)}`;
    const existing = categoryLabels.get(key);
    if (existing) return existing;
    const out = allocate(categoryLabel(category), (p, n) => `[${p}${n + 1}]`);
    categoryLabels.set(key, out);
    restoreMap[out] = original;
    return out;
  }

  const segments: OutputSegment[] = [];
  let masked = '';
  let cursor = 0;
  for (const c of sorted) {
    if (c.start > cursor) {
      const plain = text.slice(cursor, c.start);
      segments.push({ kind: 'plain', text: plain });
      masked += plain;
    }
    const out = outputs.get(c.id) ?? c.text;
    segments.push(out === c.text ? { kind: 'kept', text: out, candidateId: c.id } : { kind: 'changed', text: out, original: c.text, candidateId: c.id });
    masked += out;
    cursor = c.end;
  }
  if (cursor < text.length) {
    const plain = text.slice(cursor);
    segments.push({ kind: 'plain', text: plain });
    masked += plain;
  }
  // 複数の語が同じ語に一般化された、または同じ語が加工後の文章のほかの所にもある場合は、戻す先が決まらないので入れない
  const generalizedMap: Record<string, string> = {};
  for (const [g, { originals, count }] of generalized) {
    const [original] = originals;
    if (originals.size === 1 && original !== undefined && countOccurrences(masked, g) === count) generalizedMap[g] = original;
  }
  return { masked, segments, restoreMap, generalizedMap, outputs };
}

function countOccurrences(text: string, word: string): number {
  let n = 0;
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) n++;
  return n;
}
