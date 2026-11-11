import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { getRequestListener } from '@hono/node-server';
import { deleteExpiredEvents } from './db';
import { prepareServer } from './prepare';

// Vercel の関数の入口（SERVER_DESIGN.md §14）。scripts/build-vercel.mjs が1つのファイルにまとめて
// .vercel/output/functions/api.func に置く。管理画面のファイルは Vercel がそのまま配り、
// それ以外の要求（/v1/*・/admin/*・/health・/cron/purge）がここに来る。
//
// 関数は要求がないと止まり、次の要求で起動し直す。DB の接続とアプリの組み立ては起動ごとに1回だけ行う。

type Prepared = Awaited<ReturnType<typeof prepareServer>>;
let ready: Promise<{ listener: ReturnType<typeof getRequestListener> }> | undefined;

function prepare(): Promise<{ listener: ReturnType<typeof getRequestListener> }> {
  return prepareServer().then(({ db, app }: Prepared) => {
    // 保存期間を過ぎた記録を消す。Vercel の Cron が1日1回、CRON_SECRET を Authorization に入れて呼ぶ
    app.get('/cron/purge', async (c) => {
      const secret = process.env.CRON_SECRET;
      if (!secret) return c.text('CRON_SECRET が設定されていません。', 503);
      const expected = Buffer.from(`Bearer ${secret}`);
      const given = Buffer.from(c.req.header('authorization') ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return c.body(null, 401);
      const n = await deleteExpiredEvents(db, new Date());
      if (n) console.info(`保存期間を過ぎた記録・適用状況を ${n} 件削除しました。`);
      return c.json({ deleted: n });
    });
    return { listener: getRequestListener(app.fetch) };
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 準備に失敗したとき（DB に届かないなど）は、次の要求でやり直す
  ready ??= prepare().catch((e: unknown) => {
    ready = undefined;
    throw e;
  });
  let listener: ReturnType<typeof getRequestListener>;
  try {
    ({ listener } = await ready);
  } catch (e) {
    console.error('管理サーバーを準備できませんでした。', e instanceof Error ? e.message : e);
    res.statusCode = 503;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('管理サーバーを準備できませんでした。Vercel の Logs と環境変数（DATABASE_URL・POLICY_SIGNING_KEY）を確かめてください。');
    return;
  }
  await listener(req, res);
}
