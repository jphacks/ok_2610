import { defineConfig } from 'wxt';

// 対応AIサイト。継続的な連携を利用者が有効にしたときだけ、ドメイン単位で権限を求める（SEC-01）
const AI_SITES = ['https://gemini.google.com/*', 'https://chatgpt.com/*', 'https://claude.ai/*'];

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react'],
  manifest: ({ mode }) => ({
    name: 'テキストクリーナー',
    description: '生成AIに渡す前の文章から個人情報・機密情報を端末内で検出・加工し、残るリスクの判断を支援します。',
    minimum_chrome_version: '138',
    permissions: ['sidePanel', 'storage', 'contextMenus', 'activeTab', 'scripting', 'clipboardWrite'],
    optional_host_permissions: AI_SITES,
    action: { default_title: 'テキストクリーナーを開く' },
    storage: { managed_schema: 'managed_schema.json' },
    content_security_policy: {
      // 外部への通信は connect-src 'self' で封じる（LP-01）。開発時だけ HMR 用に localhost を許す
      extension_pages:
        mode === 'development'
          ? "script-src 'self' 'wasm-unsafe-eval' http://localhost:3000; object-src 'self'; connect-src 'self' ws://localhost:3000 http://localhost:3000"
          : "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'",
    },
  }),
});
