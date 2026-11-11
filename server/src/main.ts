import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { deleteExpiredEvents } from './db';
import { prepareServer } from './prepare';

// 管理サーバーの起動（npm run server）。手元やふつうのサーバー（Render など）で動かすとき。
// 管理画面は admin/dist（npm run admin:build）を同じオリジンで配る。Vercel では vercel.ts を使う。
//
// 環境変数は prepare.ts のほかに
//   PORT                既定 8787。拡張のビルド時の WXT_REPORT_ORIGIN と合わせる（クラウドでは自動で入ることが多い）

const port = Number(process.env.PORT ?? 8787);
const { db, app } = await prepareServer();
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
