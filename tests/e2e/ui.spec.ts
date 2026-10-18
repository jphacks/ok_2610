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

test('Excel ファイルを読み込むと、セルの文字が検査される', async ({ context, extensionId }) => {
  const { strToU8, zipSync } = await import('fflate');
  const xlsx = zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="顧客" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>連絡先</t></is></c><c r="B1" t="inlineStr"><is><t>sato.hanako@example.co.jp</t></is></c></row></sheetData></worksheet>',
    ),
    'xl/media/image1.png': strToU8('x'),
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('読み込む Excel・CSV ファイル').setInputFiles({ name: '顧客.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(xlsx) });
  await expect(page.getByLabel('解析する文章')).toHaveValue('【シート: 顧客】\n連絡先\tsato.hanako@example.co.jp');
  await expect(page.getByRole('list', { name: 'ファイルの取込結果' })).toContainText('画像は取り込んでいません');
  await expect(page.getByLabel('加工後の文章')).not.toContainText('sato.hanako@example.co.jp', { timeout: 90_000 });
  await expect(page.getByLabel('加工後の文章')).toContainText('連絡先');

  // 確認した加工文を、元と同じ形式（.xlsx）で保存する
  await page.getByLabel('元と同じ形式（.xlsx）で保存').check();
  await page.getByRole('button', { name: 'この加工文で確認する' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '確認した加工文をファイルに保存' }).click()]);
  expect(download.suggestedFilename()).toBe('顧客_加工済み.xlsx');
  const { readFileSync } = await import('node:fs');
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
  expect(sheet).toContain('連絡先');
  expect(sheet).not.toContain('sato.hanako@example.co.jp');
  expect(files['xl/media/image1.png']).toBeUndefined();

  // 本文を書き換えると、同じ形式での保存は選べなくなる
  await page.getByLabel('解析する文章').fill('別の文章です。');
  await expect(page.getByLabel('元と同じ形式（.xlsx）で保存')).toHaveCount(0);
});
