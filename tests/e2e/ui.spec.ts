import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';

const demo = readFileSync(new URL('../fixtures/demo-email.txt', import.meta.url), 'utf8');

test('狭いパネルでも工程間を移動し、原文の確認と追加加工ができる', async ({ context, extensionId }, testInfo) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill(demo);
  await expect(page.getByLabel('加工後の文章')).toContainText('人物A', { timeout: 90_000 });

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 400, 800]) {
      await page.setViewportSize({ width, height: 1000 });
      const workflow = page.getByRole('navigation', { name: '作業の流れ' });
      await workflow.getByRole('link', { name: /02.*加工文の確認/ }).click();
      await expect(page.getByRole('heading', { name: '結果', exact: true })).toBeInViewport();
      const heading = await page.getByRole('heading', { name: '結果', exact: true }).boundingBox();
      const header = await page.locator('.header').boundingBox();
      expect(heading!.y).toBeGreaterThanOrEqual(header!.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`result-${colorScheme}-${width}.png`) });

      await workflow.getByRole('link', { name: /03.*コピー・利用/ }).click();
      await expect(page.getByRole('button', { name: 'この加工文で確認する' })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`output-${colorScheme}-${width}.png`) });

      await workflow.getByRole('link', { name: /01.*文章の準備/ }).click();
      await expect(page.getByLabel('解析する文章')).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`input-${colorScheme}-${width}.png`) });
    }
  }

  await page.getByRole('navigation').getByRole('link', { name: /02.*加工文の確認/ }).click();
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.getByLabel('原文', { exact: true })).toContainText('佐藤花子');
  await page.getByRole('button', { name: '加工後', exact: true }).click();
  await expect(page.getByLabel('加工後の文章')).not.toContainText('佐藤花子');
  await page.getByText('残っている手がかりを見る').click();
  await expect(page.getByRole('list', { name: '残っている手がかり' })).toBeVisible();

  const original = await page.getByLabel('出力される文章').textContent();
  await page.getByRole('button', { name: '適用', exact: true }).first().click();
  await expect(page.getByLabel('出力される文章')).not.toHaveText(original!);
  const applied = await page.getByLabel('出力される文章').textContent();
  await page.getByRole('button', { name: '操作を元に戻す', exact: true }).click();
  await expect(page.getByLabel('出力される文章')).not.toHaveText(applied!);
  await page.getByRole('button', { name: '操作をやり直す', exact: true }).click();
  await expect(page.getByLabel('出力される文章')).toHaveText(applied!);
});
