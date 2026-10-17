import type { KeepFlags, Purpose, Stage } from '../core/model/types';

// 保存するのは設定とカスタム辞書だけ。入力本文・対応表は保存しない（LP-03、ARCHITECTURE.md §13-2）

export type Prefs = {
  stage: Stage;
  purpose: Purpose;
  keep: KeepFlags;
  useNer: boolean;
  useNano: boolean;
  customText: string;
};

export const DEFAULT_PREFS: Prefs = {
  stage: 'B',
  purpose: 'summary',
  keep: { relationships: true, dates: true, amounts: true, organizations: false },
  useNer: true,
  useNano: false,
  customText: '',
};

export async function loadPrefs(): Promise<Prefs> {
  try {
    const { prefs } = await chrome.storage.local.get('prefs');
    const merged = { ...DEFAULT_PREFS, ...(prefs as Partial<Prefs> | undefined) };
    // 廃止した段階 C などの古い値は既定に戻す
    if (merged.stage !== 'A' && merged.stage !== 'B') merged.stage = DEFAULT_PREFS.stage;
    return merged;
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  try {
    await chrome.storage.local.set({ prefs });
  } catch {
    // 保存できなくても動作は続ける（設定は次回既定値に戻る）
  }
}

export async function clearCustomDictionary(prefs: Prefs): Promise<Prefs> {
  const next = { ...prefs, customText: '' };
  await savePrefs(next);
  return next;
}

/**
 * 組織ポリシーを読む。読込みに失敗したら、検証で必ず失敗する値を返す
 * （個人設定へ弱めず、Worker 側で「停止」として扱わせるため）。
 */
export async function readManagedPolicy(): Promise<unknown> {
  try {
    return await chrome.storage.managed.get(null);
  } catch {
    return { __readError: true };
  }
}

export function onManagedPolicyChanged(cb: () => void): () => void {
  const listener = (_: unknown, area: string) => {
    if (area === 'managed') cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** 右クリックで渡されたテキストを受け取り、すぐに消す（storage.session はメモリ上） */
export async function takePendingText(): Promise<string | undefined> {
  try {
    const { pendingText } = await chrome.storage.session.get('pendingText');
    if (typeof pendingText === 'string') {
      await chrome.storage.session.remove('pendingText');
      return pendingText;
    }
  } catch {
    // 取得できなければ何もしない
  }
  return undefined;
}

export async function clearPendingText(): Promise<void> {
  try {
    await chrome.storage.session.remove('pendingText');
  } catch { /* セッションストレージを利用できない場合は何もしない */ }
}

export function onPendingText(cb: (text: string) => void, sessionId: () => number): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'session' && typeof changes.pendingText?.newValue === 'string') {
      const session = sessionId();
      void takePendingText().then((t) => session === sessionId() && t && cb(t));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
