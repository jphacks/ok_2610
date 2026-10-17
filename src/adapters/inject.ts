// AIサイトのページに注入して実行する関数。chrome.scripting.executeScript で関数ごと渡すため、
// 外部の変数・import を参照しない自己完結した関数として書く（ARCHITECTURE.md §11-2）。
// 受け取るのは確認済みの加工文だけ。原文・対応表は渡さない。送信ボタンは押さない。

export type InsertOutcome = { ok: true } | { ok: false; reason: string };

export async function insertIntoAiInput(siteId: string, text: string, expectedOrigin: string): Promise<InsertOutcome> {
  const ORIGINS: Record<string, string> = { gemini: 'https://gemini.google.com', chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai' };
  // タブ取得後の遷移にも備え、DOM に触れる前に実行先自身で照合する。
  if (ORIGINS[siteId] !== expectedOrigin || location.origin !== expectedOrigin) {
    return { ok: false, reason: '挿入先のページが変わりました。挿入先を設定し直してください。' };
  }
  const SELECTORS: Record<string, string[]> = {
    gemini: ['rich-textarea .ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]'],
    chatgpt: ['div#prompt-textarea[contenteditable="true"]', 'textarea#prompt-textarea'],
    claude: ['div.ProseMirror[contenteditable="true"]'],
  };
  const selectors = SELECTORS[siteId];
  if (!selectors) return { ok: false, reason: 'このサイトには対応していません。' };

  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  let found: HTMLElement[] = [];
  for (const sel of selectors) {
    const els = [...document.querySelectorAll<HTMLElement>(sel)].filter(visible);
    if (els.length > 0) {
      found = els;
      break;
    }
  }
  if (found.length === 0) return { ok: false, reason: '入力欄が見つかりません。サイトの構造が変わった可能性があります。' };
  if (found.length > 1) return { ok: false, reason: '入力欄が複数あり、挿入先を1つに決められません。' };
  const el = found[0] as HTMLElement;

  const read = () => (el instanceof HTMLTextAreaElement ? el.value : el.innerText);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (norm(read())) return { ok: false, reason: '入力欄が空ではありません。消してからやり直してください。' };

  const wait = () => new Promise((r) => setTimeout(r, 80));
  el.focus();
  if (el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    await wait();
    if (!norm(read())) {
      document.execCommand('insertText', false, text);
      await wait();
    }
  }
  await wait();
  if (norm(read()) !== norm(text)) {
    return { ok: false, reason: '挿入後の入力欄の内容が加工文と一致しません。入力欄を確認し、コピーで貼り付けてください。' };
  }
  return { ok: true };
}
