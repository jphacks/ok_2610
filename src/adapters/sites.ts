// 対応AIサイトの定義（要件 3「連携の完成条件」、ARCHITECTURE.md §11-2）。
// verifiedAt は実サイトで挿入と読み戻しを確かめた日。未確認のサイトはその旨を画面に出す。

export type SiteInfo = {
  id: 'gemini' | 'chatgpt' | 'claude';
  name: string;
  origin: string;
  permissionPattern: string;
  verifiedAt: string | null;
  unsupported: string[];
};

export const SITES: SiteInfo[] = [
  { id: 'gemini', name: 'Gemini', origin: 'https://gemini.google.com', permissionPattern: 'https://gemini.google.com/*', verifiedAt: null, unsupported: ['ファイル添付', '画像', '音声入力'] },
  { id: 'chatgpt', name: 'ChatGPT', origin: 'https://chatgpt.com', permissionPattern: 'https://chatgpt.com/*', verifiedAt: null, unsupported: ['ファイル添付', '画像', '音声入力'] },
  { id: 'claude', name: 'Claude', origin: 'https://claude.ai', permissionPattern: 'https://claude.ai/*', verifiedAt: null, unsupported: ['ファイル添付', '画像'] },
];

export function siteForUrl(url: string | undefined): SiteInfo | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return SITES.find((s) => s.origin === origin);
  } catch {
    return undefined;
  }
}
