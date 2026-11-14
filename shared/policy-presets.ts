import type { Policy } from '../src/core/policy';

// 初回の案内（はじめての設定）で選ぶルールのひな形（SERVER_DESIGN.md §13）。
// 管理者は情報の種類ごとの細かい表を埋めずに、3つから選ぶ。サーバーはここからポリシーの版を作り、管理画面は見え方の見本に使う。

export const PRESET_IDS = ['standard', 'strict', 'strictest'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type Preset = {
  id: PresetId;
  name: string;
  recommended: boolean;
  summary: string;
  points: string[];
  /** 版・名前・相談先・利用記録を除いた、ポリシーの中身 */
  rules: Pick<Policy, 'minStage' | 'lockedCategories' | 'prohibitedCategories'>;
};

export const PRESETS: Preset[] = [
  {
    id: 'standard',
    name: '標準',
    recommended: true,
    summary: '名前や連絡先など、その人だと分かる情報を隠します。日付や金額は残します。',
    points: ['名前・電話番号・メールアドレスは隠し、生年月日は年に、住所は都道府県までにぼかす', '注文日などの仕事の日付や金額は、要約に必要なので残す'],
    rules: { minStage: 'A' },
  },
  {
    id: 'strict',
    name: '厳しめ',
    recommended: false,
    summary: '標準に加えて、年齢や住んでいる地域もさらにぼかします。',
    points: ['生年月日は年代に、住所は地方までにぼかす', '組み合わせると本人が分かりそうな情報も弱める'],
    rules: { minStage: 'B' },
  },
  {
    id: 'strictest',
    name: '個人情報を特に厳しく',
    recommended: false,
    summary: '厳しめに加えて、社員が「隠さずに残す」を選べないようにします。',
    points: ['名前・住所・電話番号・メールアドレスは、社員が「そのまま残す」に変えられない', 'マイナンバー・口座番号・カード番号が残っていると、AI に渡す前に止める'],
    rules: {
      minStage: 'B',
      lockedCategories: ['personName', 'address', 'phone', 'email'],
      prohibitedCategories: ['myNumber', 'bankAccount', 'creditCard'],
    },
  },
];

export const presetOf = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/** ひな形と組織の情報から、ポリシーの中身（版を除く）を作る */
export function presetPolicy(preset: Preset, org: { name: string; contact: string | null; collectUsage: boolean }): Omit<Policy, 'version'> {
  return {
    name: `${org.name}（${preset.name}）`,
    ...(org.contact ? { contact: org.contact } : {}),
    ...preset.rules,
    ...(org.collectUsage ? { reporting: { enabled: true } } : {}),
  };
}

/** 見え方の見本に使う文章（架空の問合せ） */
export const PREVIEW_TEXT = '佐藤花子様（1958年4月12日生まれ、横浜市青葉区在住）から、10月3日に注文したソファについて問合せがありました。連絡先は 090-1234-5678 です。';
