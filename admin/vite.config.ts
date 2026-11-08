import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 管理画面（npm run admin:dev / admin:build）。開発時は API を記録サーバー（既定 8787）へ中継する。
const api = process.env.ADMIN_API ?? 'http://localhost:8787';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5174, proxy: { '/admin': api, '/v1': api, '/health': api } },
});
