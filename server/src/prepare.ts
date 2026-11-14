import { mkdirSync } from 'node:fs';
import { createApp, createOrganization } from './app';
import { openDb, type Db } from './db';
import { loadSigner } from './signing';

// 管理サーバーの準備（DB を開く・最初の管理者を作る・アプリを組み立てる）。
// 手元やふつうのサーバーで動かすとき（main.ts）と、Vercel の関数（vercel.ts）で同じものを使う。
//
// 環境変数
//   DATABASE_URL        PostgreSQL の接続先（例 Neon の postgresql://…?sslmode=require）。クラウドではこれを使う
//   DB_PATH             DATABASE_URL がないときの手元のデータの置き場所（PGlite）。既定 server/data/pglite
//   EXTENSION_IDS       記録を受け付ける拡張の ID（カンマ区切り）。未指定なら chrome-extension:// をすべて許す
//   ADMIN_EMAIL / ADMIN_PASSWORD / ORG_NAME  管理者がまだいないときだけ、最初の組織と管理者を作る
//   SECURE_COOKIES=1    HTTPS で動かすとき（Vercel では指定しなくても有効）
//   PUBLIC_ORIGIN       拡張に配る初期設定の送信先。未指定なら Vercel・Render が入れる公開 URL、それもなければ要求の URL
//   POLICY_SIGNING_KEY  ポリシーの署名鍵（Ed25519、PKCS#8 の PEM）。DATABASE_URL を使うときは必須
//   SIGNING_KEY_PATH    POLICY_SIGNING_KEY がないときに読む鍵のファイル。既定 server/data/policy-signing-key.pem（なければ作る）

type Env = Record<string, string | undefined>;

/** 拡張に配る初期設定の送信先。Vercel は本番のドメインを https:// なしで入れる */
export function publicOriginOf(env: Env): string | undefined {
  const raw = env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  return raw ? new URL(raw).origin : undefined;
}

export async function prepareServer(env: Env = process.env): Promise<{ db: Db; app: ReturnType<typeof createApp> }> {
  const databaseUrl = env.DATABASE_URL || undefined;
  const onVercel = !!env.VERCEL;

  // Vercel のディスクは読み取り専用で、関数が終われば消える。データは外の PostgreSQL に置くしかない
  if (onVercel && !databaseUrl) {
    throw new Error('Vercel で動かすときは、DATABASE_URL（Neon などの PostgreSQL の接続先）を環境変数で指定してください。手順は SERVER_DESIGN.md §14。');
  }
  // クラウドの無料プランなどはサーバーのディスクが消えるので、鍵をファイルに置くと起動のたびに変わってしまう。
  // 鍵が変わると、配った初期設定の公開鍵と合わなくなり、端末が新しい版を受け取れなくなるため、環境変数で渡させる
  if (databaseUrl && !env.POLICY_SIGNING_KEY) {
    throw new Error('DATABASE_URL を使うときは、POLICY_SIGNING_KEY（ポリシーの署名鍵）も環境変数で指定してください。作り方は SERVER_DESIGN.md §14。');
  }

  const dataDir = env.DB_PATH ?? 'server/data/pglite';
  if (!databaseUrl) mkdirSync(dataDir, { recursive: true });
  const db = await openDb(databaseUrl ? { url: databaseUrl } : { dataDir });

  if (!(await db.one('SELECT 1 FROM admins LIMIT 1'))) {
    const { ADMIN_EMAIL, ADMIN_PASSWORD, ORG_NAME } = env;
    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
      if (ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD は12文字以上にしてください。');
      // 同時に起動したほかのサーバーが先に作っていれば、メールアドレスの重複で失敗する。そのときは作らずに進む
      try {
        await createOrganization(db, ORG_NAME ?? 'デモ組織', ADMIN_EMAIL, ADMIN_PASSWORD);
        console.info(`管理者 ${ADMIN_EMAIL} を作成しました。`);
      } catch (e) {
        if (!(await db.one('SELECT 1 FROM admins LIMIT 1'))) throw e;
      }
    } else {
      console.warn('管理者がいません。ADMIN_EMAIL と ADMIN_PASSWORD を指定して起動すると作成します。');
    }
  }

  const publicOrigin = publicOriginOf(env);
  const app = createApp({
    db,
    extensionIds: (env.EXTENSION_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    secureCookies: env.SECURE_COOKIES === '1' || onVercel,
    signer: loadSigner({ pem: env.POLICY_SIGNING_KEY, path: env.SIGNING_KEY_PATH ?? 'server/data/policy-signing-key.pem' }),
    ...(publicOrigin ? { publicOrigin } : {}),
    signup: {
      enabled: env.ALLOW_SIGNUP === '1',
      maxOrganizations: positiveInt(env.SIGNUP_MAX_ORGS, 100),
      perHour: positiveInt(env.SIGNUP_PER_HOUR, 10),
    },
  });
  app.get('/health', (c) => c.json({ ok: true }));
  return { db, app };
}

/** 環境変数の正の整数。なければ・数でなければ既定値 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
