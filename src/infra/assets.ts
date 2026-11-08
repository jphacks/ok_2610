// 拡張に同梱したファイル（フォントなど）を読む唯一の入口（ARCHITECTURE.md §13-3, LP-01）。
// 拡張自身のオリジンの URL だけを読み、外部には取りに行かない。

export function assetUrl(path: string): string {
  return new URL(`/${path.replace(/^\/+/, '')}`, location.href).href;
}

export async function readBundledAsset(path: string): Promise<Uint8Array> {
  const url = new URL(assetUrl(path));
  if (url.origin !== location.origin) throw new Error('同梱ファイル以外は読めません');
  const res = await fetch(url.href);
  if (!res.ok) throw new Error(`同梱ファイルを読めませんでした: ${path}`);
  return new Uint8Array(await res.arrayBuffer());
}
