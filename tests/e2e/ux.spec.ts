import { expect, test } from './fixtures';

// UI/UX の直し（#8, #29）。押すとこう変わる、が画面だけで分かることを確かめる
test('空の画面の案内からサンプルで試し、仕上がりの見本を押して処理を変えられる', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: 'サンプルの問合せメールで試す' }).click();
  const output = page.getByLabel('加工後の文章');
  await expect(output).toContainText('1950年代', { timeout: 90_000 });
  await expect(page.getByLabel('色の意味と件数')).toContainText('加工');

  // 理由の欄は押した語のすぐ下（手動マスクより上）に開き、見出しは実際の仕上がりで書く
  await output.getByRole('button', { name: '1950年代' }).click();
  await expect(page.getByText(/「1950年代」/).first()).toBeVisible();
  const detailBox = await page.locator('.card.detail').boundingBox();
  const manualBox = await page.getByRole('group', { name: '手動でマスク' }).boundingBox();
  expect(detailBox!.y).toBeLessThan(manualBox!.y);

  // 見本のボタンで「年だけ」に変えると、本文がその見本どおりになる
  await page.getByRole('button', { name: /処理を「年だけ」に変える（仕上がり: 1958年）/ }).click();
  await expect(output).toContainText('1958年');
  await expect(output).not.toContainText('1950年代');
});

test('対策をまとめて適用するボタンに合わせると変わる箇所が囲まれ、適用後に元に戻せる', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: 'サンプルの問合せメールで試す' }).click();
  const plan = page.getByRole('button', { name: /対策をまとめて適用/ });
  await expect(plan).toBeVisible({ timeout: 90_000 });
  const before = await page.getByLabel('加工後の文章').textContent();
  await plan.hover();
  await expect(page.locator('.mark.pending').first()).toBeVisible();
  await plan.click();
  await expect(page.getByText(/か所を変えました/)).toBeVisible();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(page.getByLabel('加工後の文章')).toHaveText(before!);
});
