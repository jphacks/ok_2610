// 確認単位（FR-22）。入力・設定・手動操作・ポリシー版・検出器版・検査範囲・利用条件の回答を1つに束ねる。
// 送信先は UI 側で contentId と組にして照合する（ARCHITECTURE.md §9-2）。

/** キーの順序に依存しない JSON 文字列 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function computeContentId(unit: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(unit));
}
