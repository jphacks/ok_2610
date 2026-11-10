import { z } from 'zod';
import { SAFE_TOKEN } from './usage-event';

// 一元管理（SERVER_DESIGN.md §12）。拡張とサーバーで同じスキーマを使う。
// - MDM（chrome.storage.managed）で配るのは、送信先・登録トークン・署名の公開鍵という初期設定だけ
// - ポリシー本体はサーバーが Ed25519 で署名して配り、拡張は読むたびに署名を確かめる
// - 拡張からは、適用している版と状態だけを1日1回まで報告する。文章も利用者の識別子も送らない

/** 組織トークン・登録トークンの形（server/src/secrets.ts で発行する） */
export const TOKEN_PATTERN = /^tc_[A-Za-z0-9_-]{16,128}$/;
const safeToken = z.string().regex(SAFE_TOKEN);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const isoTime = z.iso.datetime();

/** managed storage の `management` に置く初期設定 */
export const ManagementBootstrapSchema = z.strictObject({
  /** 管理サーバーの URL。拡張のビルド時に許可したオリジン（WXT_REPORT_ORIGIN）と一致させる */
  endpoint: z.url({ protocol: /^https?$/ }),
  /** 部署ごとの登録トークン。社員の端末に配られるので秘密としては扱わない */
  enrollmentToken: z.string().regex(TOKEN_PATTERN),
  /** ポリシーの署名を確かめる Ed25519 の公開鍵（SPKI の DER を base64 にしたもの） */
  policyPublicKey: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(40).max(200),
});
export type ManagementBootstrap = z.infer<typeof ManagementBootstrapSchema>;

/** GET /v1/policy の応答。payload は PolicyPayload の JSON を UTF-8 にして base64url にしたもの */
export const SignedPolicySchema = z.strictObject({
  payload: z.string().regex(/^[A-Za-z0-9_-]+$/).max(256 * 1024),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
});
export type SignedPolicy = z.infer<typeof SignedPolicySchema>;

export const PolicyPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  orgId: z.number().int().positive(),
  /** 登録トークンの部署。全社のトークンなら null */
  department: safeToken.nullable(),
  /** 登録トークンの SHA-256（16進）。別の組織・部署に宛てた署名を、手元の保存場所へ差し替えられても受け取らない */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  policyId: z.number().int().positive(),
  version: z.string().min(1),
  /** 署名した時刻（日の始まりに丸める）。手元より古いものは受け取らない */
  issuedAt: isoTime,
  /** この署名を手元で使ってよい期限。通信できない間もこの時刻までは使う */
  expiresAt: isoTime,
  /** これより古い拡張では出力を止める */
  minExtensionVersion: semver.nullable(),
  /** 組織ポリシー本体（src/core/policy.ts の PolicySchema で検証する） */
  policy: z.record(z.string(), z.unknown()),
});
export type PolicyPayload = z.infer<typeof PolicyPayloadSchema>;

export const POLICY_STATES = ['active', 'expired', 'invalid', 'missing', 'outdated'] as const;
export type PolicyState = (typeof POLICY_STATES)[number];
export const POLICY_SOURCES = ['server', 'mdm'] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

/**
 * POST /v1/status の中身（適用状況）。installId は拡張の中で作った乱数で、利用者・端末の情報と結びつけない。
 * strictObject なので未知の項目が1つでもあれば拒否する。
 */
export const DeviceStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installId: z.uuid(),
  /** 日付だけ（UTC） */
  reportedDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  extensionVersion: semver,
  policyVersion: safeToken.nullable(),
  policyState: z.enum(POLICY_STATES),
  policySource: z.enum(POLICY_SOURCES),
  department: safeToken.nullable(),
});
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

/** 1.2.3 形式の版を比べる。a が古ければ負、同じなら 0 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  return base64Decode(text.replace(/-/g, '+').replace(/_/g, '/'));
}

export function base64Decode(text: string): Uint8Array {
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
