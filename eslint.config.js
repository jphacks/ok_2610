import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// 外部へ送信できる API。同梱物を読む src/infra/assets.ts と NER の読込み以外では使わない（LP-01）
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts'].map((name) => ({
  name,
  message: '外部通信の経路を増やさないため使用禁止です（ARCHITECTURE.md §13-3）。',
}));

export default tseslint.config(
  { ignores: ['.output/', '.wxt/', 'node_modules/', 'public/', '.venv-ner/', 'test-results/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-globals': ['error', ...NETWORK_GLOBALS],
      'no-restricted-properties': ['error', { object: 'navigator', property: 'sendBeacon' }],
    },
  },
  {
    // core/ は純粋関数。DOM・chrome API・時刻・乱数を使わない（ARCHITECTURE.md §3-1）
    files: ['src/core/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': [
        'error',
        ...NETWORK_GLOBALS,
        ...['window', 'document', 'chrome', 'navigator', 'localStorage'].map((name) => ({ name, message: 'core/ では使用禁止です。' })),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'core/ では時刻を引数で受け取ってください。' },
        { object: 'Math', property: 'random', message: 'core/ の結果は決定的にします。' },
      ],
    },
  },
  {
    files: ['src/engines/ner.ts', 'src/infra/assets.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.mjs', '*.config.{ts,js}'],
    languageOptions: { globals: { ...globals.node } },
  },
);
