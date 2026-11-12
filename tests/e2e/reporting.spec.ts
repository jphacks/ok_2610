import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { base64UrlEncode, DeviceStatusSchema } from '../../shared/management';
import { UsageBatchSchema } from '../../shared/usage-event';
import { expect, test } from './fixtures';

// 利用記録の送信（SERVER_DESIGN.md §3-4）。拡張は WXT_REPORT_ORIGIN=http://localhost:8787 でビルドしておく（npm run test:e2e）。
// 記録サーバーへの通信はここで横取りし、送られた本文に原文の語が含まれないことを確かめる。

const demo = readFileSync(new URL('../fixtures/demo-email.txt', import.meta.url), 'utf8');
const PII = ['佐藤花子', '田中', '090-1234-5678', 'hanako.sato@example.com', 'AB-20261003-1182', '美しが丘', '1958年4月12日', '横浜', '渋谷', '青葉家具'];
const ORIGIN = 'http://localhost:8787';
const TOKEN = 'tc_e2etesttokenvalue1234567890';

type Captured = { method: string; url: string; auth: string | null; body: string };

async function captureServer(context: BrowserContext): Promise<Captured[]> {
  const captured: Captured[] = [];
  await context.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    captured.push({ method: req.method(), url: req.url(), auth: req.headers().authorization ?? null, body: req.postData() ?? '' });
    await route.fulfill({
      status: req.method() === 'OPTIONS' ? 204 : req.method() === 'POST' ? 202 : 404,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization, if-none-match' },
    });
  });
  return captured;
}

/** chrome.storage.managed を、テストで決めた組織ポリシーに差し替える */
async function withPolicy(page: Page, policy: Record<string, unknown>) {
  await page.addInitScript((p) => {
    chrome.storage.managed.get = (async () => p) as typeof chrome.storage.managed.get;
  }, policy);
}

async function analyzeAndCopy(page: Page) {
  await page.getByLabel('解析する文章').fill(demo);
  await expect(page.getByLabel('加工後の文章')).toContainText('人物A', { timeout: 90_000 });
  const copy = page.getByRole('button', { name: '加工文をコピー' });
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(page.getByText(/コピーしました/)).toBeVisible();
}

test('組織ポリシーがなければ、コピーしても記録サーバーへ何も送らない', async ({ context, extensionId, external }) => {
  const captured = await captureServer(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await analyzeAndCopy(page);
  await page.waitForTimeout(1000);
  expect(captured).toEqual([]);
  expect(external).toEqual([]);
  await expect(page.getByText('記録：組織へ送信')).toHaveCount(0);
});

test('組織ポリシーで有効なら、文章を含まない記録だけを送り、送った中身を利用者が見られる', async ({ context, extensionId, external }) => {
  const captured = await captureServer(context);
  const page = await context.newPage();
  await withPolicy(page, { version: '2026-10', reporting: { enabled: true, endpoint: ORIGIN, orgToken: TOKEN, department: 'support' } });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByText('記録：組織へ送信')).toBeVisible({ timeout: 30_000 });
  await analyzeAndCopy(page);

  const events = () => captured.filter((c) => c.method === 'POST' && c.url === `${ORIGIN}/v1/events`);
  await expect.poll(() => events().length).toBe(1);
  const post = events()[0]!;
  expect(post.auth).toBe(`Bearer ${TOKEN}`);
  for (const s of PII) expect(post.body).not.toContain(s);
  const batch = UsageBatchSchema.parse(JSON.parse(post.body));
  expect(batch.events).toHaveLength(1);
  expect(batch.events[0]).toMatchObject({ kind: 'output', destination: 'copy', department: 'support', policyVersion: '2026-10' });
  expect(batch.events[0]!.masked.personName).toBeGreaterThan(0);
  // 適用状況は1日1回まで。文章は含まない
  const status = captured.filter((c) => c.method === 'POST' && c.url === `${ORIGIN}/v1/status`);
  expect(status).toHaveLength(1);
  for (const s of PII) expect(status[0]!.body).not.toContain(s);
  expect(DeviceStatusSchema.parse(JSON.parse(status[0]!.body))).toMatchObject({ policySource: 'mdm', policyState: 'active', policyVersion: '2026-10', department: 'support' });
  // 記録サーバー以外へは送らない
  expect(external.filter((u) => !u.startsWith(`${ORIGIN}/`))).toEqual([]);

  await page.getByRole('button', { name: '設定を開く', exact: true }).click();
  const shown = page.getByLabel('最後に送った記録');
  await expect(shown).toContainText(batch.events[0]!.eventId);
  for (const s of PII) await expect(shown).not.toContainText(s);
});

test('送信先がビルド時に許可したオリジンと違えば送らない', async ({ context, extensionId }) => {
  const captured = await captureServer(context);
  const page = await context.newPage();
  await withPolicy(page, { version: '2026-10', reporting: { enabled: true, endpoint: 'https://reports.example.com', orgToken: TOKEN } });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await analyzeAndCopy(page);
  await page.waitForTimeout(1000);
  expect(captured).toEqual([]);
  await expect(page.getByText('記録：組織へ送信')).toHaveCount(0);
});

/** 管理サーバーの代わり。署名付きのポリシーを返し、届いた記録と適用状況を残す */
async function fakeManagementServer(context: BrowserContext, opts: { department: string; policy: Record<string, unknown> }) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const day = new Date().toISOString().slice(0, 10);
  const payload = {
    schemaVersion: 1,
    orgId: 1,
    department: opts.department,
    tokenHash: createHash('sha256').update(TOKEN).digest('hex'),
    policyId: 1,
    version: String(opts.policy.version),
    issuedAt: `${day}T00:00:00.000Z`,
    expiresAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + 8 * 24 * 60 * 60 * 1000).toISOString(),
    minExtensionVersion: null,
    policy: opts.policy,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const signed = { payload: base64UrlEncode(bytes), signature: base64UrlEncode(new Uint8Array(sign(null, bytes, privateKey))) };
  // 開発者モードの組織が返す、署名付きの外す知らせ（§12-8）
  const noticeBytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, kind: 'release', orgId: 1, tokenHash: payload.tokenHash, reason: 'unassigned', issuedAt: new Date().toISOString() }));
  const releaseNotice = { payload: base64UrlEncode(noticeBytes), signature: base64UrlEncode(new Uint8Array(sign(null, noticeBytes, privateKey))) };
  const state = { online: true, released: false, captured: [] as Captured[] };
  await context.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization, if-none-match' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (!state.online) return route.fulfill({ status: 503, headers: cors });
    state.captured.push({ method: req.method(), url: req.url(), auth: req.headers().authorization ?? null, body: req.postData() ?? '' });
    if (req.method() === 'GET' && req.url() === `${ORIGIN}/v1/policy`) {
      return state.released
        ? route.fulfill({ status: 410, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(releaseNotice) })
        : route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(signed) });
    }
    return route.fulfill({ status: 202, headers: cors });
  });
  const bootstrap = { endpoint: ORIGIN, enrollmentToken: TOKEN, policyPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
  return { state, bootstrap };
}

test('管理サーバーから署名付きのポリシーを受け取って使い、書き換えられた保存分は使わずに止める', async ({ context, extensionId, external }) => {
  const { state, bootstrap } = await fakeManagementServer(context, { department: 'sales', policy: { version: '2026-11', name: '営業部', minStage: 'B', reporting: { enabled: true } } });
  const page = await context.newPage();
  await withPolicy(page, { management: bootstrap });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByText('組織ポリシー 2026-11（管理サーバー）')).toBeVisible({ timeout: 30_000 });
  await analyzeAndCopy(page);

  const posts = (path: string) => state.captured.filter((c) => c.method === 'POST' && c.url === `${ORIGIN}${path}`);
  await expect.poll(() => posts('/v1/events').length).toBe(1);
  const batch = UsageBatchSchema.parse(JSON.parse(posts('/v1/events')[0]!.body));
  // 送信先とトークンは初期設定から、部署は登録トークンの部署から決まる
  expect(posts('/v1/events')[0]!.auth).toBe(`Bearer ${TOKEN}`);
  expect(batch.events[0]).toMatchObject({ department: 'sales', policyVersion: '2026-11', stage: 'B' });
  await expect.poll(() => posts('/v1/status').length).toBe(1);
  expect(DeviceStatusSchema.parse(JSON.parse(posts('/v1/status')[0]!.body))).toMatchObject({ policySource: 'server', policyState: 'active', policyVersion: '2026-11' });
  for (const c of state.captured) for (const s of PII) expect(c.body).not.toContain(s);
  expect(external.filter((u) => !u.startsWith(`${ORIGIN}/`))).toEqual([]);

  // 利用者が DevTools で保存分を書き換えても（制限を外したポリシーに差し替えても）、署名が合わないので使わない
  await page.evaluate(async () => {
    const { managedPolicy } = (await chrome.storage.local.get('managedPolicy')) as { managedPolicy: { signed: { payload: string; signature: string } } };
    const decoded = JSON.parse(atob(managedPolicy.signed.payload.replace(/-/g, '+').replace(/_/g, '/'))) as { policy: Record<string, unknown> };
    decoded.policy = { version: '2026-11' };
    const forged = btoa(JSON.stringify(decoded)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await chrome.storage.local.set({ managedPolicy: { signed: { ...managedPolicy.signed, payload: forged } } });
  });
  state.online = false;
  await page.reload();
  await page.getByLabel('解析する文章').fill(demo);
  await expect(page.getByText('ポリシー読込み失敗')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/署名を確かめられません/).first()).toBeVisible();
});

test('開発者モードの組織から外す知らせが届いたら、保存済みの版があってもその場で個人設定に戻る', async ({ context, extensionId }) => {
  const { state, bootstrap } = await fakeManagementServer(context, { department: 'sales', policy: { version: '2026-11', reporting: { enabled: true } } });
  const page = await context.newPage();
  await withPolicy(page, { management: bootstrap });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByText('組織ポリシー 2026-11（管理サーバー）')).toBeVisible({ timeout: 30_000 });

  // 管理者が配布を取り下げた（開発者モード）。次にサイドパネルを開くと、組織の管理から外れて個人設定で動く
  state.released = true;
  await page.reload();
  await page.getByLabel('解析する文章').fill(demo);
  await expect(page.getByText('組織ポリシー 2026-11（管理サーバー）')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('出力を止めています')).toHaveCount(0);
  // 手元の版は捨ててあるので、通信できなくなっても組織の版には戻らない
  expect(await page.evaluate(async () => Object.keys(await chrome.storage.local.get(['managedPolicy', 'managedRelease'])))).toEqual(['managedRelease']);
  state.online = false;
  await page.reload();
  await expect(page.getByText('組織ポリシー 2026-11（管理サーバー）')).toHaveCount(0, { timeout: 30_000 });
});
