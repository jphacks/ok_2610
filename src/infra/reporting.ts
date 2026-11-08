import { MAX_BATCH, SAFE_TOKEN, toHour, UsageBatchSchema, UsageEventSchema, type UsageCore, type UsageEvent } from '../../shared/usage-event';
import { reportingTarget, resolvePolicy, type Reporting } from '../core/policy';
import { REPORT_ORIGIN } from './report-origin';
import { readManagedPolicy } from './storage';

// 利用記録の送信（SERVER_DESIGN.md §3-3）。外部へ送る経路はこのファイルだけに置く（ESLint の例外）。
// 送るのは shared/usage-event.ts のスキーマを通った記録だけ。文章・候補の文字列・対応表は扱わない。

const QUEUE_KEY = 'usageQueue';
const LAST_SENT_KEY = 'usageLastSent';
/** 送れない間に溜める上限。超えたら古いものから捨てる */
const QUEUE_MAX = 500;

type Target = { reporting: Reporting; policyVersion: string | null };

async function currentTarget(now: Date): Promise<Target | null> {
  const policy = resolvePolicy(await readManagedPolicy(), now.toISOString());
  const reporting = reportingTarget(policy, REPORT_ORIGIN);
  if (!reporting || policy.status !== 'active') return null;
  return { reporting, policyVersion: SAFE_TOKEN.test(policy.version) ? policy.version : null };
}

async function readQueue(): Promise<UsageEvent[]> {
  const { [QUEUE_KEY]: raw } = await chrome.storage.local.get(QUEUE_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const parsed = UsageEventSchema.safeParse(e);
    return parsed.success ? [parsed.data] : [];
  });
}

/** 組織ポリシーで送信が有効なときだけ、記録を積んで送る。失敗しても利用者の操作は止めない */
export async function recordUsage(core: UsageCore): Promise<void> {
  try {
    const now = new Date();
    const target = await currentTarget(now);
    if (!target) return;
    const event = UsageEventSchema.parse({
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      occurredHour: toHour(now),
      extensionVersion: chrome.runtime.getManifest().version,
      policyVersion: target.policyVersion,
      department: target.reporting.department ?? null,
      ...core,
    });
    const queue = await readQueue();
    await chrome.storage.local.set({ [QUEUE_KEY]: [...queue, event].slice(-QUEUE_MAX) });
    await flushUsage();
  } catch {
    /* 記録できなくても加工・出力は続ける */
  }
}

let flushing: Promise<void> | null = null;

/** 溜まった記録を送る。同時に呼ばれても送信は1本にまとめる */
export function flushUsage(): Promise<void> {
  flushing ??= flush().catch(() => undefined).finally(() => { flushing = null; });
  return flushing;
}

async function flush(): Promise<void> {
  const target = await currentTarget(new Date());
  if (!target) {
    // 組織が送信を止めたら、溜まっている記録も送らずに消す
    await chrome.storage.local.remove(QUEUE_KEY);
    return;
  }
  for (;;) {
    const batch = (await readQueue()).slice(0, MAX_BATCH);
    if (!batch.length) return;
    const body = JSON.stringify(UsageBatchSchema.parse({ events: batch }));
    let status: number;
    try {
      // keepalive: コピーした直後にサイドパネルを閉じても送信を続ける
      const res = await fetch(`${new URL(target.reporting.endpoint).origin}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.reporting.orgToken}` },
        body,
        keepalive: true,
        credentials: 'omit',
      });
      status = res.status;
    } catch {
      return; // 通信できない。次の記録か次回の起動で送り直す
    }
    // 400（形式の拒否）は送り直しても通らないので捨てる。401・429・5xx は残して後で送る
    if (status !== 202 && status !== 400) return;
    const sent = new Set(batch.map((e) => e.eventId));
    const rest = (await readQueue()).filter((e) => !sent.has(e.eventId));
    await chrome.storage.local.set({ [QUEUE_KEY]: rest, ...(status === 202 ? { [LAST_SENT_KEY]: batch.at(-1) } : {}) });
  }
}

/** 設定画面に見せる「最後に送った記録」 */
export async function lastSentUsage(): Promise<UsageEvent | null> {
  try {
    const { [LAST_SENT_KEY]: raw } = await chrome.storage.local.get(LAST_SENT_KEY);
    const parsed = UsageEventSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
