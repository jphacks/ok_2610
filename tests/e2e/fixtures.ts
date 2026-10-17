import { chromium, test as base, type BrowserContext } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve(import.meta.dirname, '../../.output/chrome-mv3');

/** ビルド済みの拡張を読み込んだ Chromium。外部へのリクエストを記録する */
export const test = base.extend<{ context: BrowserContext; extensionId: string; external: string[] }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
  external: async ({ context }, use) => {
    const urls: string[] = [];
    context.on('request', (req) => {
      const url = req.url();
      if (!/^(chrome-extension|data|blob|about|chrome):/.test(url)) urls.push(url);
    });
    await use(urls);
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
});

export const expect = test.expect;
