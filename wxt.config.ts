import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { defineConfig } from 'wxt';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

// PDF の加工・復元（Issue #9）と画像の文字の読み取りに使う部品を、拡張に同梱する。外部の CDN からは取らない
// - pdf-cmaps/: PDF.js が日本語フォントの文字を読むのに使う CMap
// - pdf-wasm/: PDF.js が JPEG2000・JBIG2 の画像と色の変換に使う wasm
// - ocr/: Tesseract.js の Worker・本体（wasm 入り）・日本語の学習データ
// - fonts/label.ttf: ラベルと元の語を PDF に書き込むフォント（BIZ UDPゴシック、SIL Open Font License）
// - face/: 画像の中の顔を見つける MediaPipe の WASM（SIMD 版だけ）とモデル（vendor/mediapipe、Apache-2.0）（Issue #11）
const PDF_CMAPS_DIR = join(pkgDir('pdfjs-dist'), 'cmaps');
const BUNDLED: { from: string; to: string }[] = [
  ...['openjpeg.wasm', 'qcms_bg.wasm', 'jbig2.wasm'].map((f) => ({ from: join(pkgDir('pdfjs-dist'), 'wasm', f), to: `pdf-wasm/${f}` })),
  { from: join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), to: 'ocr/worker.min.js' },
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => ({ from: join(pkgDir('tesseract.js-core'), f), to: `ocr/${f}` })),
  { from: join(pkgDir('@tesseract.js-data/jpn'), '4.0.0_best_int', 'jpn.traineddata.gz'), to: 'ocr/jpn.traineddata.gz' },
  { from: join(pkgDir('@expo-google-fonts/biz-udpgothic'), '400Regular', 'BIZUDPGothic_400Regular.ttf'), to: 'fonts/label.ttf' },
  { from: join(pkgDir('@expo-google-fonts/biz-udpgothic'), 'LICENSE_FONT'), to: 'fonts/LICENSE_FONT.txt' },
  ...['vision_wasm_internal.js', 'vision_wasm_internal.wasm'].map((f) => ({ from: require.resolve(`@mediapipe/tasks-vision/${f}`), to: `face/${f}` })),
  { from: join(import.meta.dirname, 'vendor', 'mediapipe', 'blaze_face_short_range.tflite'), to: 'face/blaze_face_short_range.tflite' },
];

// NER のモデル（public/models）と ONNX Runtime の WASM（public/ort）は大きく、git には入れない（.gitignore）。
// git worktree の作業フォルダには置かず、元の作業フォルダ（git の共通ディレクトリの親）の public/ にだけ置く運用なので、
// 作業フォルダに無ければ、そこにあるものをビルドの出力にだけ足す。作業フォルダの public/ にあればそちらを使う（WXT が自動で写す）
const NER_DIRS = ['models', 'ort'];
const sharedNerFiles = (): { from: string; to: string }[] => {
  if (NER_DIRS.every((d) => existsSync(join(import.meta.dirname, 'public', d)))) return [];
  let mainRoot: string;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
    mainRoot = resolve(dirname(common));
  } catch {
    return [];
  }
  if (mainRoot === resolve(import.meta.dirname)) return [];
  const out: { from: string; to: string }[] = [];
  for (const d of NER_DIRS) {
    const base = join(mainRoot, 'public', d);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!f.isFile()) continue;
      const from = join(f.parentPath, f.name);
      out.push({ from, to: `${d}/${relative(base, from).split(sep).join('/')}` });
    }
  }
  if (out.length) console.log(`NER のモデルを ${join(mainRoot, 'public')} から出力に足します（${out.length} ファイル）`);
  return out;
};

// 対応AIサイト。継続的な連携を利用者が有効にしたときだけ、ドメイン単位で権限を求める（SEC-01）
const AI_SITES = ['https://gemini.google.com/*', 'https://chatgpt.com/*', 'https://claude.ai/*'];

// 利用記録を送るサーバーのオリジン（SERVER_DESIGN.md §3-2）。指定したビルドだけ CSP の connect-src に1つ足す。
// 未指定なら従来どおり外部への通信は一切できない。
const REPORT_ORIGIN = (() => {
  const raw = process.env.WXT_REPORT_ORIGIN;
  if (!raw) return '';
  const url = new URL(raw);
  if (url.origin !== raw) throw new Error(`WXT_REPORT_ORIGIN はオリジンだけを指定してください（例 http://localhost:8787）: ${raw}`);
  return url.origin;
})();

// onnxruntime-web は WASM を assets/ にも複製するが、engines/ner.ts の wasmPaths で public/ort/ の方を読むので使われない（約26MB）
const dropBundledOrtWasm = (): Plugin => ({
  name: 'drop-bundled-ort-wasm',
  enforce: 'post',
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) {
      if (/^assets\/ort-wasm-.*\.wasm$/.test(name)) delete bundle[name];
    }
  },
});

// MediaPipe（顔の検出、Issue #11）は、使い方の統計を 60 秒ごとに Google（odml.pa.googleapis.com）へ送ろうとする。止める設定はない。
// CSP の connect-src 'self' で止まるが、コードにも送る経路を残さない（LP-01）: 送る処理を、溜まった統計を捨てるだけにし、送り先の URL も消す。
// 版を上げて書き換える場所が見つからなくなったら、黙って通さずビルドを止める
const MEDIAPIPE_PATCHES: [string, string][] = [
  ['flush(t,e){if(this.error)', 'flush(t,e){this.i=[];t?.();return;if(this.error)'],
  ['url:"https://odml.pa.googleapis.com/v1/log"', 'url:""'],
];
const noMediapipeTelemetry = (): Plugin => ({
  name: 'no-mediapipe-telemetry',
  enforce: 'pre',
  transform(code, id) {
    if (!/@mediapipe[\\/]tasks-vision[\\/]vision_bundle\.mjs$/.test(id.split('?')[0]!)) return null;
    let out = code;
    for (const [from, to] of MEDIAPIPE_PATCHES) {
      if (out.split(from).length !== 2) throw new Error(`MediaPipe の統計送信を止められません（書き換える場所が見つからない）: ${from}`);
      out = out.replace(from, to);
    }
    // 「type.googleapis.com/…」は protobuf の型の名前で、送り先ではない
    if (/https?:\/\/[^"'`\s]*googleapis\.com/.test(out)) throw new Error('MediaPipe に外部への送り先が残っています');
    return { code: out, map: null };
  },
});

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react'],
  hooks: {
    'build:publicAssets': (_, files) => {
      for (const name of readdirSync(PDF_CMAPS_DIR)) {
        if (name.endsWith('.bcmap')) files.push({ absoluteSrc: join(PDF_CMAPS_DIR, name), relativeDest: `pdf-cmaps/${name}` });
      }
      for (const f of [...BUNDLED, ...sharedNerFiles()]) files.push({ absoluteSrc: f.from, relativeDest: f.to });
    },
  },
  vite: () => ({
    plugins: [dropBundledOrtWasm(), noMediapipeTelemetry()],
    worker: { plugins: () => [dropBundledOrtWasm()] },
  }),
  manifest: ({ mode }) => ({
    name: 'テキストクリーナー',
    description: '生成AIに渡す前の文章から個人情報・機密情報を端末内で検出・加工し、残るリスクの判断を支援します。',
    minimum_chrome_version: '138',
    permissions: ['sidePanel', 'storage', 'contextMenus', 'activeTab', 'scripting', 'clipboardWrite'],
    optional_host_permissions: AI_SITES,
    action: { default_title: 'テキストクリーナーを開く' },
    storage: { managed_schema: 'managed_schema.json' },
    content_security_policy: {
      // 外部への通信は connect-src 'self' で封じる（LP-01）。開発時だけ HMR 用に localhost を許す。利用記録の送信先は REPORT_ORIGIN だけ
      extension_pages:
        mode === 'development'
          ? `script-src 'self' 'wasm-unsafe-eval' http://localhost:3000; object-src 'self'; connect-src 'self' ws://localhost:3000 http://localhost:3000${REPORT_ORIGIN ? ` ${REPORT_ORIGIN}` : ''}`
          : `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'${REPORT_ORIGIN ? ` ${REPORT_ORIGIN}` : ''}`,
    },
  }),
});
