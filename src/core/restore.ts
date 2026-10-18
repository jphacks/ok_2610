// AIの回答に含まれる仮ラベルを、対応表で原文の語に戻す（ARCHITECTURE.md §11-3）。
// 戻すのは仮ラベル・カテゴリラベルだけ。一般化や削除で消えた情報は戻さない。

export type RestoreResult = {
  restored: string;
  replacedCount: number;
  /** ラベルらしい形なのに対応表にないもの（AIが書き換えた可能性） */
  unmatched: string[];
};

const LABEL_LIKE = /\[[^\]\s]{1,12}\d+\]|(?:人物|組織|店舗|地域)[A-Z]{1,3}(?![A-Za-z])/gu;
const PSEUDO_KEY = /^(人物|組織|店舗|地域)([A-Z]{1,3})$/u;
const CATEGORY_KEY = /^\[([^\]\s]{1,12}?)(\d+)\]$/u;
/** 戻した箇所の目印。書き換えの検査で、戻した原文の語を誤って拾わないようにする */
const REPLACED = '\u0000';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const toFullwidth = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

/**
 * AIが書き換えたラベル（人物Ａ・人物 A・人物a・Aさん・電話番号1・【電話番号1】・[電話番号 1]・［電話番号1］）を探す。
 * 対応表にある仮ラベル・カテゴリ名から作った形だけを見るので、無関係な語は拾わない。戻しはしない。
 */
function findRewrites(text: string, labels: string[]): string[] {
  const alts: string[] = [];
  const categories = new Set<string>();
  for (const l of labels) {
    const p = PSEUDO_KEY.exec(l);
    if (p) {
      const [, pre, letters] = p as unknown as [string, string, string];
      alts.push(
        `${pre}${toFullwidth(letters)}(?![Ａ-Ｚ])`,
        `${pre}[ \\u3000]${letters}(?![A-Za-z])`,
        `${pre}${letters.toLowerCase()}(?![A-Za-z])`,
      );
      if (pre === '人物') alts.push(`(?<![A-Za-z人物])${letters}(?:さん|様|氏)`);
    }
    const c = CATEGORY_KEY.exec(l);
    if (c?.[1]) categories.add(c[1]);
  }
  for (const name of categories) {
    const n = escapeRegExp(name);
    alts.push(`【${n}\\s?\\d+】`, `［${n}\\s?\\d+］`, `\\[${n}\\s\\d+\\]`, `(?<![\\[［【])${n}\\d+(?![\\d\\]］】])`);
  }
  if (alts.length === 0) return [];
  return [...text.matchAll(new RegExp(alts.join('|'), 'gu'))].map((m) => m[0]);
}

export function restoreLabels(text: string, restoreMap: Record<string, string>): RestoreResult {
  const labels = Object.keys(restoreMap).sort((a, b) => b.length - a.length);
  let replacedCount = 0;
  let restored = text;
  let rest = text;
  if (labels.length > 0) {
    // 「人物A」が「人物AB」の一部に当たらないよう、英字が続く場合は除く
    const re = new RegExp(labels.map((l) => `${escapeRegExp(l)}${/[A-Z]$/.test(l) ? '(?![A-Za-z])' : ''}`).join('|'), 'gu');
    restored = text.replace(re, (m) => {
      replacedCount++;
      return restoreMap[m] ?? m;
    });
    rest = text.replace(re, REPLACED);
  }
  const unknown = [...rest.matchAll(LABEL_LIKE)].map((m) => m[0]).filter((l) => !(l in restoreMap));
  const unmatched = [...new Set([...unknown, ...findRewrites(rest, labels)])];
  return { restored, replacedCount, unmatched };
}
