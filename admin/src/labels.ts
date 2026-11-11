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

export const ROLE_LABEL: Record<string, string> = {
  owner: 'owner（すべて・管理者の管理）',
  policy_admin: 'policy_admin（ポリシーの編集・配布・トークン）',
  viewer: 'viewer（集計と変更履歴を見る）',
  dept_viewer: 'dept_viewer（担当部署の集計だけ）',
};

export const ROLE_SHORT: Record<string, string> = { owner: 'owner', policy_admin: 'policy_admin', viewer: 'viewer', dept_viewer: 'dept_viewer' };

/** 端末から届いたポリシーの状態 */
export const POLICY_STATE_LABEL: Record<string, string> = {
  active: '適用中',
  expired: '期限切れ',
  invalid: '読込み失敗',
  missing: '未取得',
  outdated: '拡張が古い',
  stopped: '管理者が停止',
};

export const AUDIT_LABEL: Record<string, string> = {
  'policy.create': 'ポリシーの版を保存',
  'assignment.publish': 'ポリシーを配布',
  'assignment.remove': '配布を取り下げ',
  'token.create': '登録トークンを発行',
  'token.revoke': '登録トークンを失効',
  'settings.immediateStop': '「すぐ止める」を切り替え',
  'admin.create': '管理者を追加',
  'admin.update': '管理者の役割を変更',
  'admin.disable': '管理者を無効化',
  'organization.update': '組織の情報を変更',
  'departments.save': '部署を登録'
};

/** 部署の表示。部署のない（全社の）トークン・配布は「全社」 */
export const deptLabel = (d: string | null | undefined) => d ?? '全社';
