import type { Action, Purpose, RiskLevel, Stage } from '../core/model/types';

export const PURPOSE_LABEL: Record<Purpose, string> = {
  summary: '要約',
  reply: '返信文の下書き',
  classify: '分類',
  rewrite: '文章の改善',
};

export const STAGE_INFO: Record<Stage, { name: string; note: string }> = {
  A: { name: 'A 識別情報を優先', note: '氏名・連絡先などを置き換えます。地域や出来事から特定される場合があります。' },
  B: { name: 'B 属性も一般化', note: '年齢・地域・日付・所属を粗くします。珍しい経歴や組合せが残る場合は、結果の「対策をまとめて適用」で原因の項目だけを加工できます。' },
};

export const STAGES: Stage[] = ['A', 'B'];

export const RISK_TONE: Record<RiskLevel, 'info' | 'warn' | 'danger' | 'unknown'> = {
  情報: 'info',
  注意: 'warn',
  要注意: 'danger',
  評価不能: 'unknown',
};

/** 項目ごとに選べる処理。short は選択肢のボタンに出す短い名前（仕上がりの見本と並べる） */
export const ACTION_CHOICES: { key: string; label: string; short: string; action: Action }[] = [
  { key: 'keep', label: 'そのまま残す', short: 'そのまま', action: { kind: 'keep' } },
  { key: 'pseudonym', label: '仮の名前（人物A など）', short: '仮の名前', action: { kind: 'pseudonym' } },
  { key: 'categoryLabel', label: '種類のラベル（[電話番号1] など）', short: '種類のラベル', action: { kind: 'categoryLabel' } },
  { key: 'partialMask', label: '一部だけ隠す（末尾4文字を残す）', short: '末尾4文字だけ', action: { kind: 'partialMask', visible: 4 } },
  { key: 'g-year', label: '年だけにする', short: '年だけ', action: { kind: 'generalize', level: 'year' } },
  { key: 'g-decade', label: '年代にする', short: '年代', action: { kind: 'generalize', level: 'decade' } },
  { key: 'g-month', label: '月単位にする', short: '月まで', action: { kind: 'generalize', level: 'month' } },
  { key: 'g-ageBand', label: '年齢帯にする', short: '年齢帯', action: { kind: 'generalize', level: 'ageBand' } },
  { key: 'g-prefecture', label: '都道府県まで広げる', short: '都道府県', action: { kind: 'generalize', level: 'prefecture' } },
  { key: 'g-region', label: '地方まで広げる', short: '地方', action: { kind: 'generalize', level: 'region' } },
  { key: 'g-industry', label: '業種にする', short: '業種', action: { kind: 'generalize', level: 'industry' } },
  { key: 'g-role', label: '役割名にする', short: '役割名', action: { kind: 'generalize', level: 'role' } },
  { key: 'g-abstract', label: '抽象的な表現にする', short: 'ぼかす', action: { kind: 'generalize', level: 'abstract' } },
  { key: 'delete', label: '削除する', short: '削除', action: { kind: 'delete' } },
];

export function actionKey(a: Action): string {
  if (a.kind === 'generalize') return `g-${a.level}`;
  if (a.kind === 'replace') return 'replace';
  return a.kind;
}
