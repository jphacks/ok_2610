import { openDb, type Db } from '../../server/src/db';

// 管理サーバーの試験用の DB。PGlite は起動に時間がかかる（WASM の準備）ので、試験ファイルごとに1回だけ起動し、
// 試験の前に表を空にして使い回す（試験ファイルごとにモジュールは分かれるので、ほかのファイルとは混ざらない）。

let shared: Promise<Db> | undefined;

/** 空の DB を返す。マイグレーションは済んだまま、データだけを消す */
export async function emptyDb(): Promise<Db> {
  shared ??= openDb();
  const db = await shared;
  const tables = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'");
  await db.run(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  return db;
}
