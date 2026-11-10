import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp, createOrganization } from './app';
import { deleteExpiredEvents, openDb } from './db';
import { loadSigner } from './signing';

// 管理サーバーの起動（npm run server）。管理画面は admin/dist（npm run admin:build）を同じオリジンで配る。
//
// 環境変数
//   PORT                既定 8787。拡張のビルド時の WXT_REPORT_ORIGIN と合わせる
//   DB_PATH             既定 server/data/text-cleaner.db
//   EXTENSION_IDS       記録を受け付ける拡張の ID（カンマ区切り）。未指定なら chrome-extension:// をすべて許す
//   ADMIN_EMAIL / ADMIN_PASSWORD / ORG_NAME  管理者がまだいないときだけ、最初の組織と管理者を作る
//   SECURE_COOKIES=1    HTTPS で動かすとき
//   PUBLIC_ORIGIN       拡張に配る初期設定の送信先（例 https://tc-admin.example.com）。未指定なら要求の URL から決める
//   POLICY_SIGNING_KEY  ポリシーの署名鍵（Ed25519、PKCS#8 の PEM）。本番は KMS などから注入する
//   SIGNING_KEY_PATH    POLICY_SIGNING_KEY がないときに読む鍵のファイル。既定 server/data/policy-signing-key.pem（なければ作る）

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? 'server/data/text-cleaner.db';
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

const hasAdmin = db.prepare('SELECT 1 FROM admins LIMIT 1').get();
if (!hasAdmin) {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ORG_NAME } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    if (ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD は12文字以上にしてください。');
    await createOrganization(db, ORG_NAME ?? 'デモ組織', ADMIN_EMAIL, ADMIN_PASSWORD);
    console.info(`管理者 ${ADMIN_EMAIL} を作成しました。`);
  } else {
    console.warn('管理者がいません。ADMIN_EMAIL と ADMIN_PASSWORD を指定して起動すると作成します。');
  }
}

const app = createApp({
  db,
  extensionIds: (process.env.EXTENSION_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  secureCookies: process.env.SECURE_COOKIES === '1',
  signer: loadSigner({ pem: process.env.POLICY_SIGNING_KEY, path: process.env.SIGNING_KEY_PATH ?? 'server/data/policy-signing-key.pem' }),
  ...(process.env.PUBLIC_ORIGIN ? { publicOrigin: new URL(process.env.PUBLIC_ORIGIN).origin } : {}),
});
app.get('/health', (c) => c.json({ ok: true }));
app.use('/*', serveStatic({ root: 'admin/dist' }));
app.get('*', serveStatic({ path: 'admin/dist/index.html' }));

// 保存期間（利用記録は13か月、適用状況は90日）を過ぎたものを、起動時と1日ごとに消す
const purge = () => {
  const n = deleteExpiredEvents(db, new Date());
  if (n) console.info(`保存期間を過ぎた記録・適用状況を ${n} 件削除しました。`);
};
purge();
setInterval(purge, 24 * 60 * 60 * 1000).unref();

serve({ fetch: app.fetch, port }, (info) => console.info(`テキストクリーナー 管理サーバー: http://localhost:${info.port}`));
