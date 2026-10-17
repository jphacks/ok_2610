import { z } from 'zod';
import { ALL_CATEGORIES } from './model/categories';
import type { Category, EngineId, Stage } from './model/types';

// 組織ポリシー（FR-18, SEC-04）。chrome.storage.managed で配られ、利用者は変更できない。
// public/managed_schema.json と項目をそろえる。

const categoryEnum = z.enum(ALL_CATEGORIES as [Category, ...Category[]]);

export const PolicySchema = z.object({
  version: z.string().min(1),
  name: z.string().optional(),
  expiresAt: z.string().optional(),
  allowedOrigins: z.array(z.string()).optional(),
  prohibitedCategories: z.array(categoryEnum).optional(),
  minStage: z.enum(['A', 'B']).optional(),
  minProfile: z.array(z.enum(['rule', 'ner', 'nano'])).optional(),
  /** 利用者が解除（そのまま残す）できない分類 */
  lockedCategories: z.array(categoryEnum).optional(),
  orgTerms: z.array(z.object({ term: z.string().min(1), label: z.string().optional() })).optional(),
  prohibitedPatterns: z.array(z.string()).optional(),
  requireConditions: z.boolean().optional(),
  contact: z.string().optional(),
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
      orgTerms: { term: string; label?: string }[];
      patterns: RegExp[];
      requireConditions: boolean;
      contact?: string;
    }
  | { status: 'error'; reason: string };

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
  const patterns: RegExp[] = [];
  for (const source of p.prohibitedPatterns ?? []) {
    try {
      patterns.push(new RegExp(source, 'u'));
    } catch {
      return { status: 'error', reason: `組織ポリシーの禁止パターン「${source}」を読み込めません。` };
    }
  }
  return {
    status: 'active',
    version: p.version,
    ...(p.name ? { name: p.name } : {}),
    ...(p.allowedOrigins ? { allowedOrigins: p.allowedOrigins } : {}),
    prohibited: p.prohibitedCategories ?? [],
    locked: [...new Set([...(p.lockedCategories ?? []), ...(p.prohibitedCategories ?? [])])],
    minStage: p.minStage ?? 'A',
    minProfile: p.minProfile ?? ['rule'],
    orgTerms: p.orgTerms ?? [],
    patterns,
    requireConditions: p.requireConditions ?? false,
    ...(p.contact ? { contact: p.contact } : {}),
  };
}

export function lockedCategories(policy: ResolvedPolicy): Category[] {
  return policy.status === 'active' ? [...new Set([...ALWAYS_LOCKED, ...policy.locked])] : ALWAYS_LOCKED;
}

export function policyVersion(policy: ResolvedPolicy): string {
  return policy.status === 'active' ? policy.version : policy.status;
}
