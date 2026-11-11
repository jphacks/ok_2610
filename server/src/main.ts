import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp, createOrganization } from './app';
import { deleteExpiredEvents, openDb } from './db';
import { loadSigner } from './signing';

// 管理サーバーの起動（npm run server）。管理画面は admin/dist（npm run admin:build）を同じオリジンで配る。
//
// 環境変数
//   PORT                既定 8787。拡張のビルド時の WXT_REPORT_ORIGIN と合わせる（クラウドでは自動で入ることが多い）
//   DATABASE_URL        PostgreSQL の接続先（例 Neon の postgresql://…?sslmode=require）。クラウドではこれを使う
//   DB_PATH             DATABASE_URL がないときの手元のデータの置き場所（PGlite）。既定 server/data/pglite
//   EXTENSION_IDS       記録を受け付ける拡張の ID（カンマ区切り）。未指定なら chrome-extension:// をすべて許す
//   ADMIN_EMAIL / ADMIN_PASSWORD / ORG_NAME  管理者がまだいないときだけ、最初の組織と管理者を作る
//   SECURE_COOKIES=1    HTTPS で動かすとき
//   PUBLIC_ORIGIN       拡張に配る初期設定の送信先（例 https://tc-admin.onrender.com）。未指定なら RENDER_EXTERNAL_URL、それもなければ要求の URL
//   POLICY_SIGNING_KEY  ポリシーの署名鍵（Ed25519、PKCS#8 の PEM）。DATABASE_URL を使うときは必須
//   SIGNING_KEY_PATH    POLICY_SIGNING_KEY がないときに読む鍵のファイル。既定 server/data/policy-signing-key.pem（なければ作る）

const port = Number(process.env.PORT ?? 8787);
const publicUrl = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || undefined;
const databaseUrl = process.env.DATABASE_URL || undefined;

// クラウドの無料プランなどはサーバーのディスクが消えるので、鍵をファイルに置くと起動のたびに変わってしまう。
// 鍵が変わると、配った初期設定の公開鍵と合わなくなり、端末が新しい版を受け取れなくなるため、環境変数で渡させる
if (databaseUrl && !process.env.POLICY_SIGNING_KEY) {
  throw new Error('DATABASE_URL を使うときは、POLICY_SIGNING_KEY（ポリシーの署名鍵）も環境変数で指定してください。作り方は SERVER_DESIGN.md §14。');
}

const dataDir = process.env.DB_PATH ?? 'server/data/pglite';
if (!databaseUrl) mkdirSync(dataDir, { recursive: true });
const db = await openDb(databaseUrl ? { url: databaseUrl } : { dataDir });

if (!(await db.one('SELECT 1 FROM admins LIMIT 1'))) {
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
  // Render は公開の URL を RENDER_EXTERNAL_URL に入れてくれるので、PUBLIC_ORIGIN を省ける
  ...(publicUrl ? { publicOrigin: new URL(publicUrl).origin } : {}),
});
app.get('/health', (c) => c.json({ ok: true }));
app.use('/*', serveStatic({ root: 'admin/dist' }));
app.get('*', serveStatic({ path: 'admin/dist/index.html' }));

// 保存期間（利用記録は13か月、適用状況は90日）を過ぎたものを、起動時と1日ごとに消す
const purge = () => {
  deleteExpiredEvents(db, new Date())
    .then((n) => { if (n) console.info(`保存期間を過ぎた記録・適用状況を ${n} 件削除しました。`); })
    .catch((e: unknown) => console.error('保存期間を過ぎた記録を消せませんでした。', e instanceof Error ? e.message : e));
};
purge();
setInterval(purge, 24 * 60 * 60 * 1000).unref();

serve({ fetch: app.fetch, port }, (info) => console.info(`テキストクリーナー 管理サーバー: http://localhost:${info.port}`));
