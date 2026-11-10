import { z } from 'zod';
import { SAFE_TOKEN } from '../../shared/usage-event';
import { ALL_CATEGORIES } from './model/categories';
import type { Category, EngineId, Stage } from './model/types';

// 組織ポリシー（FR-18, SEC-04）。chrome.storage.managed で配られ、利用者は変更できない。
// public/managed_schema.json と項目をそろえる。

const categoryEnum = z.enum(ALL_CATEGORIES as [Category, ...Category[]]);
/**
 * 分類の一覧。廃止した「組織指定語」（orgTerm。組織辞書とともに廃止）が古いポリシーに残っていても、
 * ポリシー全体を不正扱いにして出力を止めないよう、その値だけを捨てて読む
 */
const categoryList = z
  .array(z.union([categoryEnum, z.literal('orgTerm')]))
  .transform((list) => list.filter((c): c is Category => c !== 'orgTerm'));

export const PolicySchema = z.object({
  version: z.string().min(1),
  name: z.string().optional(),
  expiresAt: z.string().optional(),
  allowedOrigins: z.array(z.string()).optional(),
  prohibitedCategories: categoryList.optional(),
  minStage: z.enum(['A', 'B']).optional(),
  minProfile: z.array(z.enum(['rule', 'ner', 'nano'])).optional(),
  /** 利用者が解除（そのまま残す）できない分類 */
  lockedCategories: categoryList.optional(),
  requireConditions: z.boolean().optional(),
  contact: z.string().optional(),
  /** 文章を含まない利用記録を組織のサーバーへ送る（SERVER_DESIGN.md §3-1） */
  reporting: z
    .strictObject({
      enabled: z.boolean(),
      endpoint: z.url({ protocol: /^https?$/ }),
      /** 記録を書き込むだけの組織トークン。社員の端末に配られるので秘密としては扱わない */
      orgToken: z.string().regex(/^tc_[A-Za-z0-9_-]{16,128}$/),
      department: z.string().regex(SAFE_TOKEN).optional(),
    })
    .optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export type ResolvedPolicy =
  | { status: 'none' }
  | {
      status: 'active';
      version: string;
      name?: string;
      allowedOrigins?: string[];
      prohibited: Category[];
      locked: Category[];
      minStage: Stage;
      minProfile: EngineId[];
      requireConditions: boolean;
      contact?: string;
      reporting?: Reporting;
    }
  | { status: 'error'; reason: string };

export type Reporting = NonNullable<Policy['reporting']>;

/**
 * 利用記録を送ってよい送信先。組織ポリシーで有効にされ、送信先がビルド時に許可したオリジン（CSP の connect-src）と
 * 一致するときだけ返す。個人利用（ポリシーなし）では送らない。
 */
export function reportingTarget(policy: ResolvedPolicy, buildOrigin: string | undefined): Reporting | null {
  if (policy.status !== 'active' || !policy.reporting?.enabled || !buildOrigin) return null;
  return new URL(policy.reporting.endpoint).origin === buildOrigin ? policy.reporting : null;
}

/** 認証情報は組織ポリシーの有無に関わらず解除できない */
export const ALWAYS_LOCKED: Category[] = ['credential'];

/**
 * 管理対象ストレージから読んだ値を検証する。
 * 失敗・期限切れは個人設定へ弱めず、エラーとして返す（呼び出し側で出力を止める）。
 */
export function resolvePolicy(raw: unknown, nowIso: string): ResolvedPolicy {
  if (raw === undefined || raw === null || (typeof raw === 'object' && Object.keys(raw as object).length === 0)) {
    return { status: 'none' };
  }
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) return { status: 'error', reason: '組織ポリシーの形式が正しくありません。' };
  const p = parsed.data;
  if (p.expiresAt && p.expiresAt < nowIso) return { status: 'error', reason: `組織ポリシー（版 ${p.version}）の有効期限が切れています。` };
  return {
    status: 'active',
    version: p.version,
    ...(p.name ? { name: p.name } : {}),
    ...(p.allowedOrigins ? { allowedOrigins: p.allowedOrigins } : {}),
    prohibited: p.prohibitedCategories ?? [],
    locked: [...new Set([...(p.lockedCategories ?? []), ...(p.prohibitedCategories ?? [])])],
    minStage: p.minStage ?? 'A',
    minProfile: p.minProfile ?? ['rule'],
    requireConditions: p.requireConditions ?? false,
    ...(p.contact ? { contact: p.contact } : {}),
    ...(p.reporting ? { reporting: p.reporting } : {}),
  };
}

export function lockedCategories(policy: ResolvedPolicy): Category[] {
  return policy.status === 'active' ? [...new Set([...ALWAYS_LOCKED, ...policy.locked])] : ALWAYS_LOCKED;
}

export function policyVersion(policy: ResolvedPolicy): string {
  return policy.status === 'active' ? policy.version : policy.status;
}
