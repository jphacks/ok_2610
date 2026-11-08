import { z } from 'zod';
import { ALL_CATEGORIES } from '../src/core/model/categories';
import type { Category } from '../src/core/model/types';

// 組織へ送る利用記録（SERVER_DESIGN.md §1）。拡張とサーバーで同じスキーマを使う。
// 文章・候補の文字列・対応表は項目として持たない。strictObject なので未知の項目が1つでもあれば拒否する。

/** 件数の頭打ち。件数の組合せから文書を推測されにくくする */
export const MAX_COUNT = 20;
/** 1回の送信でまとめる件数の上限 */
export const MAX_BATCH = 50;

const count = z.number().int().min(0).max(MAX_COUNT);
const counts = z.partialRecord(z.enum(ALL_CATEGORIES as [Category, ...Category[]]), count);
/** 組織ポリシーから来る値（版・部署）。日本語の名前や人名が入る余地を作らない */
export const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,32}$/;
const safeToken = z.string().regex(SAFE_TOKEN);
const engineState = z.enum(['ok', 'skipped', 'failed']);

export const DESTINATIONS = ['copy', 'file', 'insert:gemini', 'insert:chatgpt', 'insert:claude'] as const;
export const BLOCKER_KINDS = ['credential', 'prohibited', 'engineFailed', 'uncovered', 'policy', 'recheck', 'empty', 'conditions'] as const;
export const RISK_LEVELS = ['情報', '注意', '要注意', '評価不能'] as const;

export const UsageEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  kind: z.enum(['output', 'blocked']),
  /** 1時間単位に丸めた UTC（例 2026-10-18T03:00Z） */
  occurredHour: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00Z$/),
  extensionVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  policyVersion: safeToken.nullable(),
  department: safeToken.nullable(),
  stage: z.enum(['A', 'B']),
  purpose: z.enum(['summary', 'reply', 'classify', 'rewrite']),
  /** output のときだけ */
  destination: z.enum(DESTINATIONS).nullable(),
  /** 種類ごとの加工した件数 */
  masked: counts,
  /** 種類ごとの残した候補の件数 */
  kept: counts,
  manualOps: count,
  riskLevel: z.enum(RISK_LEVELS).nullable(),
  /** blocked のときだけ */
  blockers: z.array(z.enum(BLOCKER_KINDS)).max(BLOCKER_KINDS.length),
  engines: z.strictObject({ ner: engineState, nano: engineState }),
});

export const UsageBatchSchema = z.strictObject({ events: z.array(UsageEventSchema).min(1).max(MAX_BATCH) });

export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type UsageDestination = (typeof DESTINATIONS)[number];
/** 端末側で解析結果から作る部分。ID・時刻・版・部署は送信直前に足す */
export type UsageCore = Omit<UsageEvent, 'schemaVersion' | 'eventId' | 'occurredHour' | 'extensionVersion' | 'policyVersion' | 'department'>;

/** 時刻を1時間単位に丸める（分・秒は送らない） */
export function toHour(date: Date): string {
  return `${date.toISOString().slice(0, 13)}:00Z`;
}
