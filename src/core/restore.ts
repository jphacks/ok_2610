// AIの回答に含まれる仮ラベルを、対応表で原文の語に戻す（ARCHITECTURE.md §11-3）。
// 戻すのは仮ラベル・カテゴリラベルだけ。一般化や削除で消えた情報は戻さない。

export type RestoreResult = {
  restored: string;
  replacedCount: number;
  /** ラベルらしい形なのに対応表にないもの（AIが書き換えた可能性） */
  unmatched: string[];
};

const LABEL_LIKE = /\[[^\]\s]{1,12}\d+\]|(?:人物|組織|店舗|地域)[A-Z]{1,3}(?![A-Za-z])/gu;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function restoreLabels(text: string, restoreMap: Record<string, string>): RestoreResult {
  const labels = Object.keys(restoreMap).sort((a, b) => b.length - a.length);
  let replacedCount = 0;
  let restored = text;
  if (labels.length > 0) {
    // 「人物A」が「人物AB」の一部に当たらないよう、英字が続く場合は除く
    const re = new RegExp(labels.map((l) => `${escapeRegExp(l)}${/[A-Z]$/.test(l) ? '(?![A-Za-z])' : ''}`).join('|'), 'gu');
    restored = text.replace(re, (m) => {
      replacedCount++;
      return restoreMap[m] ?? m;
    });
  }
  const unmatched = [...new Set([...restored.matchAll(LABEL_LIKE)].map((m) => m[0]).filter((l) => !(l in restoreMap)))];
  return { restored, replacedCount, unmatched };
}
