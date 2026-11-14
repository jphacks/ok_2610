import { z } from 'zod';
import { compareVersions, ManagementBootstrapSchema, TOKEN_PATTERN, type ManagementBootstrap, type PolicyPayload, type PolicySource, type PolicyState, type ReleaseNotice } from '../../shared/management';
import { SAFE_TOKEN } from '../../shared/usage-event';
import { ALL_CATEGORIES } from './model/categories';
import type { Category, EngineId, Stage } from './model/types';

// 組織ポリシー（FR-18, SEC-04）。利用者は変更できない。配り方は2通り（SERVER_DESIGN.md §12）。
// - MDM：chrome.storage.managed にポリシー本体を置く（public/managed_schema.json と項目をそろえる）
// - サーバー：managed storage には初期設定（management）だけを置き、本体は署名付きでサーバーから受け取る

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
  /**
   * 文章を含まない利用記録を組織のサーバーへ送る（SERVER_DESIGN.md §3-1）。
   * サーバーから配るときは、送信先とトークンを初期設定（management）から取るので endpoint・orgToken は要らない
   */
  reporting: z
    .strictObject({
      enabled: z.boolean(),
      endpoint: z.url({ protocol: /^https?$/ }).optional(),
      /** 記録を書き込むだけの組織トークン。社員の端末に配られるので秘密としては扱わない */
      orgToken: z.string().regex(TOKEN_PATTERN).optional(),
      department: z.string().regex(SAFE_TOKEN).optional(),
    })
    .optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

/** 利用記録・適用状況を送る先。送信先とトークンがそろっているときだけ作る */
export type ReportingTarget = { endpoint: string; orgToken: string; department?: string };

export type ResolvedPolicy =
  | { status: 'none' }
  | {
      status: 'active';
      source: PolicySource;
      version: string;
      name?: string;
      allowedOrigins?: string[];
      prohibited: Category[];
      locked: Category[];
      minStage: Stage;
      minProfile: EngineId[];
      requireConditions: boolean;
      contact?: string;
      /** 利用記録を送るとき（組織が有効にしたときだけ） */
      reporting?: ReportingTarget;
    }
  | { status: 'error'; source: PolicySource; state: Exclude<PolicyState, 'active'>; reason: string };

/**
 * 検証する前のポリシー。サイドパネルが managed storage とサーバーの署名を読んで組み立て、Worker が検証する
 * （Worker からは chrome.storage を読めないため）。
 */
export type PolicyInput =
  | { kind: 'none' }
  | { kind: 'policy'; source: PolicySource; raw: unknown; /** サーバーから配るとき、利用記録の送信先は初期設定から取る */ reportingVia?: ReportingTarget }
  | { kind: 'error'; source: PolicySource; state: Exclude<PolicyState, 'active'>; reason: string };

/**
 * 利用記録を送ってよい送信先。組織ポリシーで有効にされ、送信先がビルド時に許可したオリジン（CSP の connect-src）と
 * 一致するときだけ返す。個人利用（ポリシーなし）では送らない。
 */
export function reportingTarget(policy: ResolvedPolicy, buildOrigin: string | undefined): ReportingTarget | null {
  if (policy.status !== 'active' || !policy.reporting || !buildOrigin) return null;
  return new URL(policy.reporting.endpoint).origin === buildOrigin ? policy.reporting : null;
}

/** 認証情報は組織ポリシーの有無に関わらず解除できない */
export const ALWAYS_LOCKED: Category[] = ['credential'];

const isEmpty = (raw: unknown) => raw === undefined || raw === null || (typeof raw === 'object' && Object.keys(raw as object).length === 0);

/**
 * MDM で配られたポリシー（managed storage の中身）を検証する。
 * 失敗・期限切れは個人設定へ弱めず、エラーとして返す（呼び出し側で出力を止める）。
 */
export function resolvePolicy(raw: unknown, nowIso: string): ResolvedPolicy {
  return resolvePolicyInput(isEmpty(raw) ? { kind: 'none' } : { kind: 'policy', source: 'mdm', raw }, nowIso);
}

export function resolvePolicyInput(input: PolicyInput, nowIso: string): ResolvedPolicy {
  if (input.kind === 'none') return { status: 'none' };
  if (input.kind === 'error') return { status: 'error', source: input.source, state: input.state, reason: input.reason };
  const { source } = input;
  const parsed = PolicySchema.safeParse(input.raw);
  if (!parsed.success) return { status: 'error', source, state: 'invalid', reason: '組織ポリシーの形式が正しくありません。' };
  const p = parsed.data;
  if (p.expiresAt && p.expiresAt < nowIso) return { status: 'error', source, state: 'expired', reason: `組織ポリシー（版 ${p.version}）の有効期限が切れています。` };
  const reporting = !p.reporting?.enabled
    ? undefined
    : input.reportingVia
      ? input.reportingVia
      : p.reporting.endpoint && p.reporting.orgToken
        ? { endpoint: p.reporting.endpoint, orgToken: p.reporting.orgToken, ...(p.reporting.department ? { department: p.reporting.department } : {}) }
        : undefined;
  return {
    status: 'active',
    source,
    version: p.version,
    ...(p.name ? { name: p.name } : {}),
    ...(p.allowedOrigins ? { allowedOrigins: p.allowedOrigins } : {}),
    prohibited: p.prohibitedCategories ?? [],
    locked: [...new Set([...(p.lockedCategories ?? []), ...(p.prohibitedCategories ?? [])])],
    minStage: p.minStage ?? 'A',
    minProfile: p.minProfile ?? ['rule'],
    requireConditions: p.requireConditions ?? false,
    ...(p.contact ? { contact: p.contact } : {}),
    ...(reporting ? { reporting } : {}),
  };
}

/** managed storage の中身から、ポリシーの配り方を決める。初期設定（management）だけならサーバーから受け取る */
export type ManagedMode =
  | { kind: 'none' }
  | { kind: 'mdm'; raw: unknown }
  | { kind: 'server'; bootstrap: ManagementBootstrap }
  | { kind: 'invalid' };

export function managedMode(raw: unknown): ManagedMode {
  if (isEmpty(raw)) return { kind: 'none' };
  const keys = Object.keys(raw as object);
  // ポリシー本体が直接書かれていれば、今までどおり MDM のポリシーを使う
  if (keys.some((k) => k !== 'management')) return { kind: 'mdm', raw };
  const parsed = ManagementBootstrapSchema.safeParse((raw as { management?: unknown }).management);
  return parsed.success ? { kind: 'server', bootstrap: parsed.data } : { kind: 'invalid' };
}

/** 手元に保存した署名付きポリシーを確かめた結果（署名の検証は infra/management.ts） */
export type ServerPolicyCheck = {
  bootstrap: ManagementBootstrap;
  /** ビルド時に許可した送信先のオリジン */
  buildOrigin: string | undefined;
  /** 署名が合ったときの中身。手元に無いときは null */
  payload: PolicyPayload | null;
  /** 手元にあるが、署名・形式が合わない */
  tampered: boolean;
  /** 署名を確かめた「外す」知らせ（開発者モードの組織が、失効・配布の取り下げのときに返す）。なければ null */
  release: ReleaseNotice | null;
  /** 初期設定の登録トークンの SHA-256（16進） */
  tokenHash: string;
  extensionVersion: string;
  nowIso: string;
};

/**
 * サーバーから受け取ったポリシーを使ってよいかを決める。使えないときは理由を付けて止める（個人設定へ弱めない）。
 * 状態は管理画面の適用状況にも使う（missing・invalid・expired・outdated）。
 */
export function serverPolicyInput(c: ServerPolicyCheck): PolicyInput {
  const error = (state: Exclude<PolicyState, 'active'>, reason: string): PolicyInput => ({ kind: 'error', source: 'server', state, reason });
  if (!c.buildOrigin || new URL(c.bootstrap.endpoint).origin !== c.buildOrigin) {
    return error('invalid', '組織の管理サーバーが、この版の拡張で許可した送信先と一致しません。管理者に連絡してください。');
  }
  // 開発者モードで管理者が外した端末は、組織の管理から外れて個人設定で動く。
  // 宛先が今の登録トークンと合う知らせだけを使う（トークンを貼り替えれば、新しいトークンで受け取り直す）
  if (c.release && c.release.tokenHash === c.tokenHash) return { kind: 'none' };
  if (c.tampered) return error('invalid', '保存されている組織ポリシーの署名を確かめられません。ネットワークにつないで、サイドパネルを開き直してください。');
  const p = c.payload;
  if (!p) return error('missing', '組織ポリシーをまだ受け取っていません。ネットワークにつないで、サイドパネルを開き直してください。');
  if (p.tokenHash !== c.tokenHash) return error('invalid', '保存されている組織ポリシーは、この端末の登録先に宛てたものではありません。サイドパネルを開き直してください。');
  if (p.expiresAt < c.nowIso) return error('expired', '組織ポリシーを最後に受け取ってから日数が経ちすぎました。ネットワークにつないで、サイドパネルを開き直してください。');
  if (p.minExtensionVersion && compareVersions(c.extensionVersion, p.minExtensionVersion) < 0) {
    return error('outdated', `拡張の版 ${c.extensionVersion} は、組織が求める版 ${p.minExtensionVersion} より古いため使えません。拡張を更新してください。`);
  }
  return {
    kind: 'policy',
    source: 'server',
    raw: p.policy,
    reportingVia: { endpoint: c.bootstrap.endpoint, orgToken: c.bootstrap.enrollmentToken, ...(p.department ? { department: p.department } : {}) },
  };
}

export function lockedCategories(policy: ResolvedPolicy): Category[] {
  return policy.status === 'active' ? [...new Set([...ALWAYS_LOCKED, ...policy.locked])] : ALWAYS_LOCKED;
}

export function policyVersion(policy: ResolvedPolicy): string {
  return policy.status === 'active' ? policy.version : policy.status;
}
