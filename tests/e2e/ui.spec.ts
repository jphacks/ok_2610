import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';

const demo = readFileSync(new URL('../fixtures/demo-email.txt', import.meta.url), 'utf8');

test('メイン画面だけで確認・コピーでき、設定は別画面で変更できる', async ({ context, extensionId }, testInfo) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('dialog', { name: '設定', exact: true })).not.toBeVisible();
  await expect(page.getByLabel('AIに頼む作業')).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('empty-light-400.png') });
  await page.getByLabel('解析する文章').fill(demo);
  const output = page.getByLabel('加工後の文章');
  await expect(output).toContainText('人物A', { timeout: 90_000 });
  await expect(output).toHaveCount(1);
  await expect(page.getByLabel('解析する文章')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '削除', exact: true })).toHaveCount(1);
  await expect(page.locator('.output-panel .output-preview')).toHaveCount(0);
  await expect(page.getByText('検査の詳細', { exact: true })).toBeVisible();
  await expect(page.getByText(/NER: 実行/)).not.toBeVisible();
  const copy = page.getByRole('button', { name: '加工文をコピー' });
  await copy.click();
  await expect(page.getByRole('status').filter({ hasText: 'コピーしました' })).toBeVisible();

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 400, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(copy).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`review-${colorScheme}-${width}.png`) });
      await page.getByRole('button', { name: '設定を開く', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '設定', exact: true });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`settings-${colorScheme}-${width}.png`) });
      // Tab 移動が設定画面内にとどまり、Escape で入口へ戻る。
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(page.getByRole('button', { name: '設定を開く', exact: true })).toBeFocused();
    }
  }

  await page.getByRole('button', { name: '設定を開く', exact: true }).click();
  await page.getByRole('radio', { name: 'A 識別情報を優先' }).click();
  // 変更直後は解析し直すまで出力できない。閉じてからも入力内容は維持される。
  expect(await copy.isEnabled()).toBe(false);
  await page.getByRole('button', { name: '文章に戻る' }).click();
  await expect(page.getByLabel('解析する文章')).toHaveValue(demo);
  await expect(copy).toBeEnabled();
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.getByLabel('原文', { exact: true })).toContainText('佐藤花子');
  await expect(copy).toBeDisabled();
  await page.getByRole('button', { name: '加工後に戻って確認' }).click();
  await expect(output).not.toContainText('佐藤花子');
  await expect(copy).toBeEnabled();
});

test('個別の追加加工と元に戻す操作、利用条件への導線を保つ', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill(demo);
  const output = page.getByLabel('加工後の文章');
  await expect(output).toContainText('人物A', { timeout: 90_000 });
  await page.getByText('理由と個別の対策', { exact: true }).click();
  await expect(page.getByRole('list', { name: '残っている手がかり' })).toBeVisible();
  const before = await output.textContent();
  await page.getByRole('button', { name: '適用', exact: true }).first().click();
  await expect(output).not.toHaveText(before!);
  const applied = await output.textContent();
  await page.getByRole('button', { name: '操作を元に戻す', exact: true }).click();
  await expect(output).toHaveText(before!);
  await page.getByRole('button', { name: '操作をやり直す', exact: true }).click();
  await expect(output).toHaveText(applied!);
  await page.getByRole('button', { name: /利用条件.*未回答/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '利用条件の確認' })).toBeVisible();
  await dialog.getByRole('radio', { name: '分からない' }).first().click();
  await page.getByRole('button', { name: '文章に戻る' }).click();
  await expect(page.locator('.output-panel')).toContainText('未確認事項あり');
  await expect(page.getByRole('button', { name: '利用条件を確認', exact: true })).toBeVisible();
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
  // プレビューはシートの表として描く
  await expect(page.getByRole('tab', { name: '顧客' })).toBeVisible();
  await expect(page.getByLabel('加工後の文章').getByRole('cell').first()).toHaveText('連絡先');
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await expect(page.getByLabel('原文', { exact: true }).getByRole('cell').nth(1)).toHaveText('sato.hanako@example.co.jp');
  await page.getByRole('button', { name: '加工後', exact: true }).click();

  // 加工文を、元と同じ形式（.xlsx）で保存する
  await page.getByLabel('出力先を変更').click();
  await page.getByLabel('元と同じ形式（.xlsx）で保存').check();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '加工文をファイルに保存' }).click()]);
  expect(download.suggestedFilename()).toBe('顧客_加工済み.xlsx');
  const { readFileSync } = await import('node:fs');
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
  expect(sheet).toContain('連絡先');
  expect(sheet).not.toContain('sato.hanako@example.co.jp');
  expect(files['xl/media/image1.png']).toBeUndefined();

  // 削除して文章を入れ直すと、同じ形式での保存は選べなくなる
  await page.getByRole('button', { name: '削除', exact: true }).click();
  await page.getByRole('button', { name: '削除する' }).click();
  await page.getByLabel('解析する文章').fill('別の文章です。');
  await expect(page.getByLabel('元と同じ形式（.xlsx）で保存')).toHaveCount(0);
});
