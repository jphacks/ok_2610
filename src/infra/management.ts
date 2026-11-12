import { DeviceStatusSchema, SignedPolicySchema, type DeviceStatus, type PolicyPayload, type PolicySource, type ReleaseNotice } from '../../shared/management';
import { SAFE_TOKEN } from '../../shared/usage-event';
import { managedMode, reportingTarget, resolvePolicyInput, serverPolicyInput, type PolicyInput, type ResolvedPolicy } from '../core/policy';
import { sha256Hex, verifySignedPolicy, verifyReleaseNotice } from './policy-signature';
import { REPORT_ORIGIN } from './report-origin';
import { readManagedPolicy } from './storage';

// 一元管理の通信（SERVER_DESIGN.md §12）。外部へ送る経路は reporting.ts とこのファイルだけに置く（ESLint の例外）。
// - 組織ポリシーを管理サーバーから受け取り、署名付きのまま chrome.storage.local に取っておく
// - 適用している版と状態を1日1回まで報告する。文章・利用者の識別子は扱わない

const CACHE_KEY = 'managedPolicy';
/** 開発者モードの組織から届いた、署名付きの外す知らせ（SERVER_DESIGN.md §12-8） */
const RELEASE_KEY = 'managedRelease';
/** v1.0.0 の「すぐ止める」で置いた知らせ。今は使わないので、見つけたら消す */
const LEGACY_STOP_KEY = 'managedStop';
const INSTALL_ID_KEY = 'installId';
const STATUS_DAY_KEY = 'statusSentDay';
const STATUS_LAST_KEY = 'statusLastSent';
const TIMEOUT_MS = 10_000;

type Cache = { signed: unknown; etag?: string };

async function readCache(): Promise<Cache | null> {
  try {
    const { [CACHE_KEY]: raw } = await chrome.storage.local.get(CACHE_KEY);
    return raw && typeof raw === 'object' ? (raw as Cache) : null;
  } catch {
    return null;
  }
}

/** 手元の署名付きポリシーを、今の初期設定の公開鍵で確かめる。書き換えられていれば tampered */
async function verifiedCache(publicKey: string): Promise<{ payload: PolicyPayload | null; tampered: boolean; etag?: string }> {
  const cache = await readCache();
  if (!cache) return { payload: null, tampered: false };
  const payload = await verifySignedPolicy(cache.signed, publicKey);
  return payload ? { payload, tampered: false, ...(cache.etag ? { etag: cache.etag } : {}) } : { payload: null, tampered: true };
}

/** 手元の外す知らせ。署名が合わなければ無いものとする */
async function verifiedRelease(publicKey: string): Promise<ReleaseNotice | null> {
  try {
    const { [RELEASE_KEY]: raw } = await chrome.storage.local.get(RELEASE_KEY);
    return raw ? await verifyReleaseNotice(raw, publicKey) : null;
  } catch {
    return null;
  }
}

/**
 * Worker に渡す検証前のポリシーを組み立てる。MDM のポリシーはそのまま、サーバーのポリシーは署名を確かめてから渡す。
 */
export async function readPolicyInput(now = new Date()): Promise<PolicyInput> {
  const mode = managedMode(await readManagedPolicy());
  switch (mode.kind) {
    case 'none':
      return { kind: 'none' };
    case 'mdm':
      return { kind: 'policy', source: 'mdm', raw: mode.raw };
    case 'invalid':
      return { kind: 'error', source: 'server', state: 'invalid', reason: '組織の管理サーバーの初期設定の形式が正しくありません。管理者に連絡してください。' };
    case 'server': {
      const { payload, tampered } = await verifiedCache(mode.bootstrap.policyPublicKey);
      return serverPolicyInput({
        bootstrap: mode.bootstrap,
        buildOrigin: REPORT_ORIGIN,
        payload,
        tampered,
        release: await verifiedRelease(mode.bootstrap.policyPublicKey),
        tokenHash: await sha256Hex(mode.bootstrap.enrollmentToken),
        extensionVersion: chrome.runtime.getManifest().version,
        nowIso: now.toISOString(),
      });
    }
  }
}

export async function readResolvedPolicy(now = new Date()): Promise<ResolvedPolicy> {
  return resolvePolicyInput(await readPolicyInput(now), now.toISOString());
}

let syncing: Promise<'updated' | 'unchanged'> | null = null;

/**
 * 管理サーバーから組織ポリシーを受け取る。サーバーから配る設定のときだけ通信する。
 * 署名・宛先が合わないもの、手元より古いものは受け取らない。通信できなければ手元の版をそのまま使う。
 */
export function syncManagedPolicy(): Promise<'updated' | 'unchanged'> {
  syncing ??= sync().catch(() => 'unchanged' as const).finally(() => { syncing = null; });
  return syncing;
}

async function sync(): Promise<'updated' | 'unchanged'> {
  const mode = managedMode(await readManagedPolicy());
  if (mode.kind !== 'server' || !REPORT_ORIGIN) return 'unchanged';
  const origin = new URL(mode.bootstrap.endpoint).origin;
  if (origin !== REPORT_ORIGIN) return 'unchanged';
  const current = await verifiedCache(mode.bootstrap.policyPublicKey);
  let res: Response;
  try {
    res = await fetch(`${origin}/v1/policy`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${mode.bootstrap.enrollmentToken}`,
        ...(current.payload && current.etag ? { 'if-none-match': current.etag } : {}),
      },
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return 'unchanged'; // 通信できない。手元の版を期限まで使う
  }
  const tokenHash = await sha256Hex(mode.bootstrap.enrollmentToken);
  if (res.status === 410) return applyRelease(await res.json().catch(() => null), mode.bootstrap.policyPublicKey, tokenHash);
  if (res.status !== 200) return 'unchanged'; // 304（変わっていない）・401・404・5xx は手元の版のまま
  const signed = SignedPolicySchema.safeParse(await res.json().catch(() => null));
  if (!signed.success) return 'unchanged';
  const payload = await verifySignedPolicy(signed.data, mode.bootstrap.policyPublicKey);
  if (!payload || payload.tokenHash !== tokenHash) return 'unchanged';
  // 配り直された（または新しいトークンで受け取れた）ので、組織の管理に戻る。前の知らせは要らない
  await chrome.storage.local.remove([RELEASE_KEY, LEGACY_STOP_KEY]);
  // 手元より古い署名は受け取らない（古い版へ戻す攻撃を防ぐ）。管理者が古い版を配り直したときは新しい日付で署名される
  if (current.payload && payload.issuedAt < current.payload.issuedAt) return 'unchanged';
  const etag = res.headers.get('etag') ?? undefined;
  await chrome.storage.local.set({ [CACHE_KEY]: { signed: signed.data, ...(etag ? { etag } : {}) } satisfies Cache });
  // 署名の時刻は毎日変わるので、中身（版・ポリシー・最低版）が変わったときだけ「更新された」と知らせる
  return current.payload && sameContent(current.payload, payload) ? 'unchanged' : 'updated';
}

/**
 * 開発者モードの組織から届いた知らせを確かめ、手元の版を捨てて組織の管理から外れる（個人設定で動く）。
 * 署名と宛先が合わないものは無視する（手元の版を期限まで使う、今までどおりの動き）。
 */
async function applyRelease(body: unknown, publicKey: string, tokenHash: string): Promise<'updated' | 'unchanged'> {
  const notice = await verifyReleaseNotice(body, publicKey);
  if (!notice || notice.tokenHash !== tokenHash) return 'unchanged';
  const before = await verifiedRelease(publicKey);
  await chrome.storage.local.set({ [RELEASE_KEY]: body });
  await chrome.storage.local.remove([CACHE_KEY, LEGACY_STOP_KEY]);
  return before && before.tokenHash === tokenHash ? 'unchanged' : 'updated';
}

const contentOf = (p: PolicyPayload) => JSON.stringify([p.policyId, p.version, p.minExtensionVersion, p.policy]);
const sameContent = (a: PolicyPayload, b: PolicyPayload) => contentOf(a) === contentOf(b);

/** 適用状況を送る先。サーバーから配る設定なら初期設定、MDM なら利用記録の送信先（組織が有効にしたときだけ） */
async function statusTarget(policy: ResolvedPolicy): Promise<{ endpoint: string; token: string; source: PolicySource; department: string | null } | null> {
  if (!REPORT_ORIGIN) return null;
  const mode = managedMode(await readManagedPolicy());
  if (mode.kind === 'server') {
    if (new URL(mode.bootstrap.endpoint).origin !== REPORT_ORIGIN) return null;
    const department = policy.status === 'active' ? policy.reporting?.department ?? null : null;
    return { endpoint: mode.bootstrap.endpoint, token: mode.bootstrap.enrollmentToken, source: 'server', department };
  }
  const target = reportingTarget(policy, REPORT_ORIGIN);
  return target ? { endpoint: target.endpoint, token: target.orgToken, source: 'mdm', department: target.department ?? null } : null;
}

async function installId(): Promise<string> {
  const { [INSTALL_ID_KEY]: id } = await chrome.storage.local.get(INSTALL_ID_KEY);
  if (typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: fresh });
  return fresh;
}

/** 適用状況を1日1回まで送る。送れなくても利用者の操作は止めない */
export async function reportStatus(now = new Date()): Promise<void> {
  try {
    const policy = await readResolvedPolicy(now);
    if (policy.status === 'none') return;
    const target = await statusTarget(policy);
    if (!target) return;
    const day = now.toISOString().slice(0, 10);
    const status = DeviceStatusSchema.parse({
      schemaVersion: 1,
      installId: await installId(),
      reportedDay: day,
      extensionVersion: chrome.runtime.getManifest().version,
      policyVersion: policy.status === 'active' && SAFE_TOKEN.test(policy.version) ? policy.version : null,
      policyState: policy.status === 'active' ? 'active' : policy.state,
      policySource: target.source,
      department: target.department,
    } satisfies DeviceStatus);
    const { [STATUS_DAY_KEY]: sentDay, [STATUS_LAST_KEY]: last } = await chrome.storage.local.get([STATUS_DAY_KEY, STATUS_LAST_KEY]);
    // 同じ日に同じ中身を送り直さない。版や状態が変わったときだけ、その日のうちに送り直す
    if (sentDay === day && JSON.stringify(last) === JSON.stringify(status)) return;
    const res = await fetch(`${new URL(target.endpoint).origin}/v1/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
      body: JSON.stringify(status),
      keepalive: true,
      credentials: 'omit',
    });
    if (res.status === 202) await chrome.storage.local.set({ [STATUS_DAY_KEY]: day, [STATUS_LAST_KEY]: status });
  } catch {
    /* 通信できない。次にサイドパネルを開いたときに送る */
  }
}

/** 設定画面に見せる「最後に送った適用状況」 */
export async function lastSentStatus(): Promise<DeviceStatus | null> {
  try {
    const { [STATUS_LAST_KEY]: raw } = await chrome.storage.local.get(STATUS_LAST_KEY);
    const parsed = DeviceStatusSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
