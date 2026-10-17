import { CATEGORY_INFO, primaryCategory } from '../model/categories';
import type { Category, Entity, EntityKind, ManualOp } from '../model/types';
import { comparisonKey } from '../detect/normalize';

type Mention = { id: string; start: number; end: number; text: string; categories: Category[] };

/** 読み仮名の括弧と敬称を除いた比較キー */
export function mentionKey(text: string): string {
  return comparisonKey(text.replace(/[（(][^）)]*[）)]/gu, ''));
}

/** A, B, …, Z, AA, AB … */
export function letterLabel(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** 原文に既にある文字列と同じラベルは使わない（FR-11 ラベル衝突の回避） */
export function makeLabelAllocator(originalText: string) {
  const counters = new Map<string, number>();
  return (prefix: string, format: (prefix: string, n: number) => string): string => {
    for (;;) {
      const n = counters.get(prefix) ?? 0;
      counters.set(prefix, n + 1);
      const label = format(prefix, n);
      if (!originalText.includes(label)) return label;
    }
  };
}

/**
 * 同一対象の統合（FR-07）。
 * 人名は「田中」と「田中花子」のように先頭が一致し、候補が1人だけなら同じ人物とみなす。
 * 同じ名字のフルネームが複数あれば統合せず、利用者の確認に回す。
 */
export function resolveEntities(
  mentions: Mention[],
  ops: ManualOp[],
  allocate: ReturnType<typeof makeLabelAllocator>,
): { entities: Entity[]; entityOf: Map<string, string>; ambiguous: Set<string> } {
  const groups = new Map<string, { kind: EntityKind; prefix: string; keys: Set<string>; mentions: Mention[] }>();
  const ambiguous = new Set<string>();
  const forcedSingles = new Set(
    ops.filter((o): o is Extract<ManualOp, { kind: 'splitEntity' }> => o.kind === 'splitEntity').map((o) => `${o.start}:${o.end}`),
  );

  const byKind = new Map<EntityKind, Mention[]>();
  for (const m of mentions) {
    const info = CATEGORY_INFO[primaryCategory(m.categories)];
    if (!info.entityKind || !info.pseudonymPrefix) continue;
    const list = byKind.get(info.entityKind) ?? [];
    list.push(m);
    byKind.set(info.entityKind, list);
  }

  for (const [kind, list] of byKind) {
    const keys = [...new Set(list.map((m) => mentionKey(m.text)))];
    const canonicalOf = new Map<string, string>();
    for (const key of keys) {
      if (kind !== 'person') {
        canonicalOf.set(key, key);
        continue;
      }
      const longer = keys.filter((k) => k !== key && (k.startsWith(key) || (key.length >= 2 && k.endsWith(key) && /[・]/u.test(k))));
      if (longer.length === 1 && longer[0]) canonicalOf.set(key, longer[0]);
      else {
        canonicalOf.set(key, key);
        if (longer.length > 1) for (const m of list) if (mentionKey(m.text) === key) ambiguous.add(m.id);
      }
    }
    for (const m of [...list].sort((a, b) => a.start - b.start)) {
      const single = forcedSingles.has(`${m.start}:${m.end}`);
      const groupKey = single ? `${kind}|single|${m.start}` : `${kind}|${canonicalOf.get(mentionKey(m.text))}`;
      const info = CATEGORY_INFO[primaryCategory(m.categories)];
      const g = groups.get(groupKey) ?? { kind, prefix: info.pseudonymPrefix ?? '対象', keys: new Set<string>(), mentions: [] };
      g.keys.add(mentionKey(m.text));
      g.mentions.push(m);
      groups.set(groupKey, g);
    }
  }

  // 手動の統合（from の表記を into の対象へ寄せる）
  for (const op of ops) {
    if (op.kind !== 'mergeEntity') continue;
    const fromKey = mentionKey(op.from);
    const intoKey = mentionKey(op.into);
    const from = [...groups.entries()].find(([, g]) => g.keys.has(fromKey));
    const into = [...groups.entries()].find(([, g]) => g.keys.has(intoKey));
    if (!from || !into || from[0] === into[0]) continue;
    into[1].mentions.push(...from[1].mentions);
    for (const k of from[1].keys) into[1].keys.add(k);
    groups.delete(from[0]);
  }

  const ordered = [...groups.values()].sort(
    (a, b) => Math.min(...a.mentions.map((m) => m.start)) - Math.min(...b.mentions.map((m) => m.start)),
  );
  const entities: Entity[] = [];
  const entityOf = new Map<string, string>();
  ordered.forEach((g, i) => {
    const id = `e${i}`;
    const canonical = [...g.mentions].sort((a, b) => b.text.length - a.text.length)[0]?.text ?? '';
    entities.push({
      id,
      kind: g.kind,
      label: allocate(g.prefix, (p, n) => `${p}${letterLabel(n)}`),
      canonical,
      mentionIds: g.mentions.map((m) => m.id),
      userConfirmed: ops.some((o) => o.kind === 'mergeEntity' && g.keys.has(mentionKey(o.into))),
    });
    for (const m of g.mentions) entityOf.set(m.id, id);
  });
  return { entities, entityOf, ambiguous };
}
