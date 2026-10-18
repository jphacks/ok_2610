import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';

const demo = readFileSync(new URL('../fixtures/demo-email.txt', import.meta.url), 'utf8');

test('デモの問合せメールを解析し、解析し終えた最新の加工文だけを出力できる（AT-01, AT-02, AT-05, AT-07）', async ({ context, extensionId, external }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill(demo);

  // 判断支援: 組合せの手がかりと、原因の項目だけを加工する対策
  await expect(page.getByText('組合せの手がかり: 要注意')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: /対策をまとめて適用/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /^C/ })).toHaveCount(0);

  // NER がブラウザの Worker 内で動いたか（スパイク S4）
  await page.getByText('検査の詳細', { exact: true }).click();
  await expect(page.getByText(/NER: 実行（\d+件/)).toBeVisible({ timeout: 90_000 });

  // AT-01: 加工後の文章に氏名・連絡先が残らない
  const output = page.getByLabel('加工後の文章');
  await expect(output).toContainText('人物A');
  for (const s of ['佐藤花子', '090-1234-5678', 'hanako.sato@example.com']) await expect(output).not.toContainText(s);

  // 項目を押すと理由が出る
  await page.getByLabel('加工後の文章').getByRole('button', { name: '人物A' }).first().click();
  await expect(page.getByText('氏名はそれだけで本人を特定できます。')).toBeVisible();

  // 解析し終えた版はコピー1回で出力できる（押した時点の版を確認済みにする）
  const copy = page.getByRole('button', { name: '加工文をコピー' });
  await expect(copy).toBeEnabled();

  // AT-05: 設定を変えると、解析し直すまで出力できない
  await page.getByRole('button', { name: '設定を開く', exact: true }).click();
  await page.getByRole('radio', { name: 'A 識別情報を優先' }).click();
  expect(await copy.isEnabled()).toBe(false);
  await page.getByRole('button', { name: '設定を閉じる' }).click();
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(page.getByText(/コピーしました/)).toBeVisible();

  // AT-07: 解析・加工の間に外部へのリクエストが 0 件
  expect(external).toEqual([]);
});

test('認証情報が残る操作はできず、出力を止める（SF-02）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill('APIキーは sk-proj-abcdefghijklmnopqrstuvwx です。');
  const output = page.getByLabel('加工後の文章');
  await expect(output).not.toContainText('sk-proj', { timeout: 60_000 });
  await page.getByLabel('加工後の文章').getByRole('button').first().click();
  await page.getByRole('button', { name: '解除（残す）' }).click();
  await expect(page.getByText(/認証情報は常に解除できません/)).toBeVisible();
  await expect(output).not.toContainText('sk-proj');
});

test('AIの回答の仮ラベルを元に戻せる', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill(demo);
  await expect(page.getByLabel('加工後の文章')).toContainText('人物A', { timeout: 90_000 });
  await page.getByText('AIの回答を復元').click();
  // 仮ラベルは出現順に振られるので、実際の加工文から佐藤花子のラベルを読む
  const label = await page.getByLabel('加工後の文章').getByRole('button', { name: /^人物[A-Z]+$/ }).first().textContent();
  await page.getByRole('textbox', { name: 'AIの回答' }).fill(`${label}さんは[注文番号1]の配達日を気にしています。`);
  await page.getByRole('button', { name: 'ラベルを元の語に戻す' }).click();
  await expect(page.getByLabel('元に戻した文章')).toHaveText('佐藤花子さんはAB-20261003-1182の配達日を気にしています。');
});

test('対策をまとめて適用すると注意度が下がり、1回の「元に戻す」でまとめて戻る（段階 C の代わり）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByLabel('解析する文章').fill(demo);
  const plan = page.getByRole('button', { name: /対策をまとめて適用/ });
  await expect(plan).toBeVisible({ timeout: 90_000 });
  const before = await page.getByLabel('加工後の文章').textContent();
  await plan.click();
  await expect(page.getByText('組合せの手がかり: 要注意')).toHaveCount(0);
  await expect(page.getByLabel('加工後の文章')).toContainText('10月3日');
  await page.getByRole('button', { name: '操作を元に戻す', exact: true }).click();
  await expect(page.getByText('組合せの手がかり: 要注意')).toBeVisible();
  await expect(page.getByLabel('加工後の文章')).toHaveText(before!);
});
