import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { WorkerRequest } from '../../src/worker/protocol';
import { insertIntoAiInput } from '../../src/adapters/inject';
import { expect, test } from './fixtures';

type ReviewWindow = Window & typeof globalThis & {
  security: {
    policy: Record<string, unknown>;
    listeners: Parameters<typeof chrome.storage.onChanged.addListener>[0][];
    policyReads: number;
    failAnalysis: boolean;
    terminated: number;
    tabUrl: string;
    insertions: number;
    holdQuery: boolean;
    releaseQuery?: () => void;
  };
};

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as ReviewWindow;
    w.security = { policy: {}, listeners: [], policyReads: 0, failAnalysis: false, terminated: 0, tabUrl: 'https://chatgpt.com/', insertions: 0, holdQuery: false };
    chrome.storage.managed.get = (async () => { w.security.policyReads++; return w.security.policy; }) as typeof chrome.storage.managed.get;
    const addListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
    chrome.storage.onChanged.addListener = listener => { w.security.listeners.push(listener); addListener(listener); };
    const removeListener = chrome.storage.onChanged.removeListener.bind(chrome.storage.onChanged);
    chrome.storage.onChanged.removeListener = listener => {
      w.security.listeners = w.security.listeners.filter(item => item !== listener);
      removeListener(listener);
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: WorkerRequest, options?: Transferable[] | StructuredSerializeOptions) {
      if (w.security.failAnalysis && message.type === 'analyze') {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, ok: false, error: 'SECURITY_TEST_FAILURE' } })));
      } else post.call(this, message, options as StructuredSerializeOptions);
    };
    const terminate = Worker.prototype.terminate;
    Worker.prototype.terminate = function () { w.security.terminated++; terminate.call(this); };
    chrome.tabs.query = (async () => {
      if (w.security.holdQuery) await new Promise<void>(resolve => { w.security.releaseQuery = resolve; });
      return [{ id: 42, url: w.security.tabUrl }];
    }) as unknown as typeof chrome.tabs.query;
    chrome.permissions.request = (async () => true) as typeof chrome.permissions.request;
    chrome.scripting.executeScript = (async () => { w.security.insertions++; return [{ result: { ok: true }, frameId: 0, documentId: 'test-document' }]; }) as typeof chrome.scripting.executeScript;
  });
}

test('設定変更直後と解析例外時に古い確認でコピーできない', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await instrument(page);
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill('電話は080-9876-5432です。');
  const confirm = page.getByRole('button', { name: 'この加工文で確認する' });
  const copy = page.getByRole('button', { name: '確認した加工文をコピー' });
  await expect(confirm).toBeEnabled({ timeout: 90_000 });
  await confirm.click();
  await expect(copy).toBeEnabled();
  await page.evaluate(() => { (window as ReviewWindow).security.failAnalysis = true; });
  await page.getByRole('button', { name: '設定を開く', exact: true }).click();
  await page.getByRole('radio', { name: 'A 識別情報を優先' }).click();
  await page.getByRole('button', { name: '設定を閉じる' }).click();
  // ポーリングで350msの隙間を見逃さない。
  expect(await copy.isEnabled()).toBe(false);
  expect(await confirm.isEnabled()).toBe(false);
  await expect(page.getByRole('alert')).toContainText('SECURITY_TEST_FAILURE');
  await expect(copy).toBeDisabled();
  await expect(confirm).toBeDisabled();
  await page.evaluate(() => { (window as ReviewWindow).security.failAnalysis = false; });
  await page.getByRole('button', { name: '設定を開く', exact: true }).click();
  await page.getByRole('radio', { name: 'B 属性も一般化' }).click();
  await page.getByRole('button', { name: '設定を閉じる' }).click();
  await expect(confirm).toBeEnabled();
  await expect(copy).toBeDisabled();
  await confirm.click();
  await expect(copy).toBeEnabled();
});

test('削除後は復元済み個人情報も回答も残らず、解析Workerも終了する', async ({ context, extensionId, external }) => {
  const page = await context.newPage();
  await instrument(page);
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill(readFileSync(new URL('../fixtures/demo-email.txt', import.meta.url), 'utf8'));
  await expect(page.getByLabel('加工後の文章')).toContainText('人物A', { timeout: 90_000 });
  await page.getByText('AIの回答を復元').click();
  await page.getByRole('textbox', { name: 'AIの回答' }).fill('人物Aさんへ返信します。');
  await page.getByRole('button', { name: 'ラベルを元の語に戻す' }).click();
  await expect(page.getByLabel('元に戻した文章')).toHaveText('佐藤花子さんへ返信します。');
  await page.getByRole('button', { name: '削除', exact: true }).click();
  await page.getByRole('button', { name: '削除する' }).click();
  expect(await page.evaluate(() => (window as ReviewWindow).security.terminated)).toBeGreaterThan(0);
  await page.getByLabel('解析する文章').fill('電話は080-9876-5432です。');
  await expect(page.getByLabel('加工後の文章')).toContainText('[電話番号1]', { timeout: 90_000 });
  await page.getByText('AIの回答を復元').click();
  await expect(page.getByRole('textbox', { name: 'AIの回答' })).toHaveValue('');
  await expect(page.getByLabel('元に戻した文章')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('佐藤花子');
  expect(external).toEqual([]);
});

test('通知を閉じなくても同じ版番号のポリシー更新が反映される', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await instrument(page);
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill('電話は080-9876-5432です。');
  const confirm = page.getByRole('button', { name: 'この加工文で確認する' });
  const copy = page.getByRole('button', { name: '確認した加工文をコピー' });
  await expect(confirm).toBeEnabled({ timeout: 90_000 });
  for (const requireConditions of [false, true, false]) {
    const reads = await page.evaluate(requireConditions => {
      const s = (window as ReviewWindow).security;
      const before = s.policyReads;
      s.policy = { version: 'same-version', requireConditions };
      s.listeners.forEach(listener => listener({}, 'managed'));
      return before;
    }, requireConditions);
    expect(await copy.isEnabled()).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as ReviewWindow).security.policyReads)).toBeGreaterThan(reads);
    if (requireConditions) {
      await expect(page.getByText('組織ポリシーにより、利用条件の確認が済むまで出力できません。')).toBeVisible();
      await expect(confirm).toBeDisabled();
    } else {
      await expect(confirm).toBeEnabled();
      await expect(copy).toBeDisabled();
      await confirm.click();
      await expect(copy).toBeEnabled();
    }
  }
});

test('同一タブの別ドメインへの遷移と、挿入待ち中の変更で挿入を止める', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await instrument(page);
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill('電話は080-9876-5432です。');
  const confirm = page.getByRole('button', { name: 'この加工文で確認する' });
  await expect(confirm).toBeEnabled({ timeout: 90_000 });
  await page.getByLabel('出力先を変更').click();
  await page.getByRole('radio', { name: '表示中のAIサイトの入力欄に挿入' }).check();
  await confirm.click();
  const insert = page.getByRole('button', { name: '確認した加工文を入力欄に挿入' });
  await page.evaluate(() => { (window as ReviewWindow).security.tabUrl = 'https://claude.ai/'; });
  await insert.click();
  await expect(page.getByText('挿入先のタブが切り替わりました。挿入先を設定し直してください。')).toBeVisible();
  expect(await page.evaluate(() => (window as ReviewWindow).security.insertions)).toBe(0);

  await page.getByRole('radio', { name: '表示中のAIサイトの入力欄に挿入' }).check();
  await confirm.click();
  await page.evaluate(() => { (window as ReviewWindow).security.holdQuery = true; });
  await insert.click();
  await expect.poll(() => page.evaluate(() => Boolean((window as ReviewWindow).security.releaseQuery))).toBe(true);
  await page.getByRole('button', { name: '設定を開く', exact: true }).click();
  await page.getByRole('radio', { name: 'A 識別情報を優先' }).click();
  await page.getByRole('button', { name: '設定を閉じる' }).click();
  await page.evaluate(() => { const s = (window as ReviewWindow).security; s.holdQuery = false; s.releaseQuery!(); });
  await expect(confirm).toBeEnabled();
  expect(await page.evaluate(() => (window as ReviewWindow).security.insertions)).toBe(0);
  await confirm.click();
  await insert.click();
  await expect.poll(() => page.evaluate(() => (window as ReviewWindow).security.insertions)).toBe(1);
});

test('挿入関数自身が実行先のドメインを検証する', async ({ context }) => {
  const page = await context.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<textarea id="prompt-textarea"></textarea>' }));
  await page.goto('https://example.test/');
  const call = `(${insertIntoAiInput.toString()})('chatgpt', 'DUMMY-REVIEW-TEXT', 'https://chatgpt.com')`;
  expect(await page.evaluate(call)).toMatchObject({ ok: false });
  await expect(page.locator('textarea')).toHaveValue('');
  await page.goto('https://chatgpt.com/');
  expect(await page.evaluate(call)).toEqual({ ok: true });
  await expect(page.locator('textarea')).toHaveValue('DUMMY-REVIEW-TEXT');
});
