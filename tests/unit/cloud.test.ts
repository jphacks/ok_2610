import { beforeEach, expect, test } from 'vitest';
import { createApp, createOrganization } from '../../server/src/app';
import type { Db } from '../../server/src/db';
import { publicOriginOf } from '../../server/src/prepare';
import { emptyDb } from './db-helpers';

// クラウド（Vercel・Render）に置くときの振る舞い（SERVER_DESIGN.md §14）

let db: Db;

beforeEach(async () => {
  db = await emptyDb();
});

test('拡張に配る送信先は、PUBLIC_ORIGIN、Render の URL、Vercel の本番ドメインの順に決まる', () => {
  expect(publicOriginOf({ PUBLIC_ORIGIN: 'https://admin.example.com/', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' })).toBe('https://admin.example.com');
  expect(publicOriginOf({ RENDER_EXTERNAL_URL: 'https://tc.onrender.com' })).toBe('https://tc.onrender.com');
  // Vercel は https:// を付けずに入れる
  expect(publicOriginOf({ VERCEL_PROJECT_PRODUCTION_URL: 'tc-admin.vercel.app' })).toBe('https://tc-admin.vercel.app');
  expect(publicOriginOf({})).toBeUndefined();
});

test('ログインの失敗は DB に数えるので、別々に動くサーバーをまたいでも5回で止まる', async () => {
  await createOrganization(db, 'デモ組織', 'admin@example.com', 'correct horse battery staple');
  const login = (app: ReturnType<typeof createApp>, password: string) =>
    app.request('/admin/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password }) });
  // Vercel では要求ごとに別の関数（別のメモリ）が動くことがある
  const apps = [createApp({ db }), createApp({ db }), createApp({ db })];
  for (let i = 0; i < 5; i++) expect((await login(apps[i % 3]!, 'wrong')).status).toBe(401);
  expect((await login(apps[2]!, 'correct horse battery staple')).status).toBe(429);
});

test('ログインに成功すると、それまでの失敗の数を消す', async () => {
  await createOrganization(db, 'デモ組織', 'admin@example.com', 'correct horse battery staple');
  const app = createApp({ db });
  const login = (password: string) =>
    app.request('/admin/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'Admin@Example.com', password }) });
  for (let i = 0; i < 4; i++) expect((await login('wrong')).status).toBe(401);
  expect((await login('correct horse battery staple')).status).toBe(200);
  expect(await db.query('SELECT 1 FROM login_failures')).toHaveLength(0);
});
