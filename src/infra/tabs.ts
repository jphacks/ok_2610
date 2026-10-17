import { insertIntoAiInput, type InsertOutcome } from '../adapters/inject';
import type { SiteInfo } from '../adapters/sites';

export type ActiveTab = { id: number; url?: string; title?: string };

export async function getActiveTab(): Promise<ActiveTab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return undefined;
  return { id: tab.id, ...(tab.url ? { url: tab.url } : {}), ...(tab.title ? { title: tab.title } : {}) };
}

/** 利用者の操作時に、表示中のタブの選択テキストを読む（activeTab。読むだけ） */
export async function importSelection(tabId: number): Promise<string> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.getSelection()?.toString() ?? '' });
  return typeof res?.result === 'string' ? res.result : '';
}

/** 継続的なサイト連携の権限を、そのサイトのドメインだけ求める（SEC-01）。クリックの中で呼ぶ */
export function requestSitePermission(site: SiteInfo): Promise<boolean> {
  return chrome.permissions.request({ origins: [site.permissionPattern] });
}

export function hasSitePermission(site: SiteInfo): Promise<boolean> {
  return chrome.permissions.contains({ origins: [site.permissionPattern] });
}

export async function insertToTab(tabId: number, site: SiteInfo, text: string): Promise<InsertOutcome> {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: insertIntoAiInput, args: [site.id, text, site.origin] });
    return (res?.result as InsertOutcome | undefined) ?? { ok: false, reason: '挿入の結果を受け取れませんでした。' };
  } catch {
    return { ok: false, reason: 'このタブに書き込む権限がありません。権限を許可するか、コピーで貼り付けてください。' };
  }
}
