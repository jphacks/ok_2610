// Chrome 組込み Prompt API（Gemini Nano）の型。使う範囲だけを宣言する。
// https://developer.chrome.com/docs/extensions/ai/prompt-api

type LanguageModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

type LanguageModelExpected = { type: 'text'; languages?: string[] };

interface LanguageModelCreateOptions {
  initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  topK?: number;
  expectedInputs?: LanguageModelExpected[];
  expectedOutputs?: LanguageModelExpected[];
  monitor?: (m: EventTarget) => void;
  signal?: AbortSignal;
}

interface LanguageModelSession {
  prompt(input: string, options?: { responseConstraint?: object; signal?: AbortSignal }): Promise<string>;
  clone(): Promise<LanguageModelSession>;
  destroy(): void;
}

interface LanguageModelStatic {
  availability(options?: Pick<LanguageModelCreateOptions, 'expectedInputs' | 'expectedOutputs'>): Promise<LanguageModelAvailability>;
  params?(): Promise<{ defaultTopK: number; maxTopK: number; defaultTemperature: number; maxTemperature: number }>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

// グローバルに生える API なので var で宣言する（未対応のブラウザでは typeof で確かめる）
// eslint-disable-next-line no-var
declare var LanguageModel: LanguageModelStatic;
