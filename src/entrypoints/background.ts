import { defineBackground } from 'wxt/utils/define-background';

// Service Worker。パネルの起動と右クリックメニューだけを担い、本文は保持しない（ARCHITECTURE.md §3-4）

const MENU_ID = 'text-cleaner-analyze';

export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'テキストクリーナーで解析', contexts: ['selection'] });
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || tab?.windowId === undefined) return;
    // パネルを開くのは利用者の操作の中で同期的に行う必要があるため、保存より先に呼ぶ
    void chrome.sidePanel.open({ windowId: tab.windowId });
    // 受け渡しは storage.session（メモリ上）。パネルが読んだ直後に消す
    void chrome.storage.session.set({ pendingText: info.selectionText ?? '' });
  });
});
