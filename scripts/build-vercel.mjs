// Vercel に置くための出力（Build Output API v3）を .vercel/output に作る（npm run vercel:build。SERVER_DESIGN.md §14）。
// - static/              管理画面（admin/dist）。Vercel がそのまま配る
// - functions/api.func/  管理サーバー（server/src/vercel.ts を1つのファイルにまとめたもの）
// - config.json          管理画面のファイルがなければ関数へ回す道順と、1日1回の掃除（Cron）
//
// 拡張（WXT）のビルドとは別。拡張のファイルや NER のモデルは含めない。

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const out = '.vercel/output';
const fn = `${out}/functions/api.func`;

if (!existsSync('admin/dist/index.html')) throw new Error('admin/dist がありません。先に npm run admin:build を実行してください。');

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });
cpSync('admin/dist', `${out}/static`, { recursive: true });

await build({
  entryPoints: ['server/src/vercel.ts'],
  outfile: `${fn}/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // pg-native は使わない（pg が必要なときだけ読む）。PGlite は手元用で、DATABASE_URL があれば読まない
  external: ['pg-native', '@electric-sql/pglite'],
  // pg などの CommonJS が require('events') などを使うので、ESM の中でも require を使えるようにする
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  maxDuration: 30,
}, null, 2));

writeFileSync(`${out}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    // 管理画面のファイル（/・/assets/…）があればそれを返し、なければ管理サーバーへ回す
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/api' },
  ],
  // 保存期間を過ぎた記録を消す（UTC 18時＝日本時間 3時ごろ。無料プランは1日1回まで、時刻は1時間ほどずれる）
  crons: [{ path: '/cron/purge', schedule: '0 18 * * *' }],
}, null, 2));

console.info(`Vercel 用の出力を ${out} に作りました。`);
