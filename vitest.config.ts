import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // 管理サーバーの試験は、ファイルごとに最初の1回だけ PGlite（WASM の PostgreSQL）を起動するので、準備に時間がかかることがある
    hookTimeout: 30_000,
  },
});
