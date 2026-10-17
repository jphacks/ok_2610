import { afterEach, expect, test, vi } from 'vitest';
import { clearPendingText, onPendingText } from '../../src/infra/storage';

afterEach(() => vi.unstubAllGlobals());

test('削除前に読み始めた取込文章を削除後に反映しない', async () => {
  let listener!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  let finish!: (value: { pendingText: string }) => void;
  const remove = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', { storage: {
    session: { get: () => new Promise(resolve => { finish = resolve; }), remove },
    onChanged: { addListener: (f: typeof listener) => { listener = f; }, removeListener: vi.fn() },
  } });
  let session = 0;
  const receive = vi.fn();
  const off = onPendingText(receive, () => session);
  listener({ pendingText: { newValue: 'old-dummy' } }, 'session');
  session++;
  await clearPendingText();
  finish({ pendingText: 'old-dummy' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(receive).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith('pendingText');
  listener({ pendingText: { newValue: 'new-dummy' } }, 'session');
  finish({ pendingText: 'new-dummy' });
  await vi.waitFor(() => expect(receive).toHaveBeenCalledWith('new-dummy'));
  off();
});
