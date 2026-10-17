import type { EngineOutput } from '../core/analyze';
import { chunkText, entitiesToSpans, type NerToken } from './ner-post';

// 日本語NER（tsmatz/xlm-roberta-ner-japanese）を Transformers.js で端末内実行する。Worker 内で使う。
// 実行時に外部通信しない: リモートモデル無効・WASM は同梱物から読む・CSP connect-src 'self'（LP-01）

export const NER_MODEL_ID = 'tsmatz/xlm-roberta-ner-japanese';
export const NER_VERSION = `${NER_MODEL_ID}@aba094e1:q8`;

type Classifier = (text: string, options: { ignore_labels: string[] }) => Promise<NerToken[]>;

let loading: Promise<Classifier> | null = null;

function baseUrl(): string {
  return `${self.location.origin}/`;
}

async function load(): Promise<Classifier> {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = `${baseUrl()}models/`;
  env.useBrowserCache = false;
  // 既定では WASM を CDN から読み、Blob URL 経由で読み込む。どちらも使わず同梱物を直接読む
  env.useWasmCache = false;
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = {
      mjs: `${baseUrl()}ort/ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${baseUrl()}ort/ort-wasm-simd-threaded.asyncify.wasm`,
    };
    // 拡張ページはクロスオリジン分離されていないため、スレッドは使えない
    onnx.wasm.numThreads = 1;
  }
  const classifier = await pipeline('token-classification', NER_MODEL_ID, { dtype: 'q8', device: 'wasm' });
  return classifier as unknown as Classifier;
}

/** モデルが同梱されているか。読み込む前に確かめ、無ければ理由を返す */
export async function nerAvailability(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${baseUrl()}models/${NER_MODEL_ID}/manifest.json`);
    if (!res.ok) return { ok: false, reason: 'NERモデルが同梱されていません（npm run setup:ner）' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'NERモデルが同梱されていません（npm run setup:ner）' };
  }
}

/** 例外を投げない。失敗は status と reason に正規化する（ARCHITECTURE.md §5-1） */
export async function detectNer(text: string): Promise<EngineOutput> {
  const t0 = performance.now();
  try {
    const available = await nerAvailability();
    if (!available.ok) return { engine: 'ner', status: 'unavailable', reason: available.reason ?? '利用できません', ms: 0, spans: [], version: NER_VERSION };
    loading ??= load();
    const classify = await loading;
    const spans = [];
    for (const chunk of chunkText(text)) {
      if (!chunk.text.trim()) continue;
      const tokens = await classify(chunk.text, { ignore_labels: [] });
      spans.push(...entitiesToSpans(chunk.text, tokens, chunk.offset));
    }
    return { engine: 'ner', status: 'ok', ms: Math.round(performance.now() - t0), spans, version: NER_VERSION };
  } catch (e) {
    loading = null;
    return {
      engine: 'ner',
      status: 'failed',
      reason: e instanceof Error ? e.message.slice(0, 120) : '不明なエラー',
      ms: Math.round(performance.now() - t0),
      spans: [],
      version: NER_VERSION,
    };
  }
}
