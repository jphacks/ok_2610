import { CATEGORY_INFO } from '../../src/core/model/categories';
import type { Category } from '../../src/core/model/types';

// 管理画面の表示名。記録の値（英字）を、管理者が読める言葉に直す。

export const categoryLabel = (c: string) => CATEGORY_INFO[c as Category]?.label ?? c;

export const DESTINATION_LABEL: Record<string, string> = {
  copy: 'コピー',
  file: 'ファイル保存',
  'insert:gemini': 'Gemini に挿入',
  'insert:chatgpt': 'ChatGPT に挿入',
  'insert:claude': 'Claude に挿入',
};

export const BLOCKER_LABEL: Record<string, string> = {
  credential: '認証情報',
  prohibited: '禁止した情報',
  policy: 'ポリシーの読込み失敗',
};

export const RISK_ORDER = ['情報', '注意', '要注意', '評価不能'];

export const AI_SITES = [
  { origin: 'https://gemini.google.com', name: 'Gemini' },
  { origin: 'https://chatgpt.com', name: 'ChatGPT' },
  { origin: 'https://claude.ai', name: 'Claude' },
];
