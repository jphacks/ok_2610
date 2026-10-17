import type { EngineOutput } from '../core/analyze';
import { chunkText } from './ner-post';
import { answerToSpans, NANO_SCHEMA, NANO_SYSTEM_PROMPT, parseNanoAnswer } from './nano-parse';

// Chrome 組込み Gemini Nano（Prompt API）。Web Worker では使えないため、サイドパネルから呼ぶ。
// 推論はブラウザ側で非同期に進むので UI スレッドは固まらない。

export const NANO_VERSION = 'gemini-nano:prompt-api';
const LANG = { expectedInputs: [{ type: 'text' as const, languages: ['ja'] }], expectedOutputs: [{ type: 'text' as const, languages: ['ja'] }] };

export type NanoAvailability = LanguageModelAvailability | 'unsupported';

export async function nanoAvailability(): Promise<NanoAvailability> {
  if (typeof LanguageModel === 'undefined') return 'unsupported';
  try {
    return await LanguageModel.availability(LANG);
  } catch {
    return 'unavailable';
  }
}

let base: Promise<LanguageModelSession> | null = null;

async function createBase(): Promise<LanguageModelSession> {
  const params = await LanguageModel.params?.().catch(() => undefined);
  return LanguageModel.create({
    ...LANG,
    initialPrompts: [{ role: 'system', content: NANO_SYSTEM_PROMPT }],
    // 結果の揺れを抑える（拡張では topK・temperature を指定できる。両方そろえて渡す必要がある）
    ...(params ? { temperature: 0, topK: 1 } : {}),
  });
}

/**
 * モデルの取得を始める。利用者の操作（クリック）の中で、await を挟まずに呼ぶこと。
 * ユーザー操作の有効期限が切れると取得を始められない。
 */
export function startNanoDownload(onProgress: (ratio: number) => void): Promise<boolean> {
  if (typeof LanguageModel === 'undefined') return Promise.resolve(false);
  return LanguageModel.create({
    ...LANG,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress((e as Event & { loaded: number }).loaded));
    },
  })
    .then((s) => {
      s.destroy();
      return true;
    })
    .catch(() => false);
}

/** 例外を投げない。JSON が壊れたら1回だけ再試行する */
export async function detectNano(text: string): Promise<EngineOutput> {
  const t0 = performance.now();
  try {
    const availability = await nanoAvailability();
    if (availability !== 'available') {
      const reason = availability === 'unsupported' ? 'このブラウザでは Prompt API が使えません' : availability === 'unavailable' ? 'この端末では Gemini Nano が使えません' : 'モデルがまだ取得されていません';
      return { engine: 'nano', status: 'unavailable', reason, ms: 0, spans: [], version: NANO_VERSION };
    }
    base ??= createBase();
    const root = await base;
    const spans = [];
    for (const chunk of chunkText(text, 1200)) {
      if (!chunk.text.trim()) continue;
      let answer = null;
      for (let attempt = 0; attempt < 2 && !answer; attempt++) {
        const session = await root.clone();
        try {
          answer = parseNanoAnswer(await session.prompt(chunk.text, { responseConstraint: NANO_SCHEMA }));
        } finally {
          session.destroy();
        }
      }
      if (!answer) throw new Error('Gemini Nano の出力を読み取れませんでした');
      spans.push(...answerToSpans(chunk.text, answer, chunk.offset));
    }
    return { engine: 'nano', status: 'ok', ms: Math.round(performance.now() - t0), spans, version: NANO_VERSION };
  } catch (e) {
    base = null;
    return {
      engine: 'nano',
      status: 'failed',
      reason: e instanceof Error ? e.message.slice(0, 120) : '不明なエラー',
      ms: Math.round(performance.now() - t0),
      spans: [],
      version: NANO_VERSION,
    };
  }
}
