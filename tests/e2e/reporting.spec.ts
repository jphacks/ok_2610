import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
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
      status: req.method() === 'OPTIONS' ? 204 : 202,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, authorization' },
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

  await expect.poll(() => captured.filter((c) => c.method === 'POST').length).toBe(1);
  const post = captured.find((c) => c.method === 'POST')!;
  expect(post.url).toBe(`${ORIGIN}/v1/events`);
  expect(post.auth).toBe(`Bearer ${TOKEN}`);
  for (const s of PII) expect(post.body).not.toContain(s);
  const batch = UsageBatchSchema.parse(JSON.parse(post.body));
  expect(batch.events).toHaveLength(1);
  expect(batch.events[0]).toMatchObject({ kind: 'output', destination: 'copy', department: 'support', policyVersion: '2026-10' });
  expect(batch.events[0]!.masked.personName).toBeGreaterThan(0);
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
