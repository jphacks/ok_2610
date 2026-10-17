import { afterEach, expect, test, vi } from 'vitest';
import { createWorkerClient } from '../../src/infra/worker-client';

afterEach(() => vi.unstubAllGlobals());

test('Worker 終了時は進行中の呼出しを破棄し、新しい呼出しも受け付けない', async () => {
  const terminate = vi.fn();
  const postMessage = vi.fn();
  vi.stubGlobal('Worker', class {
    terminate = terminate;
    postMessage = postMessage;
  });
  const client = createWorkerClient();
  const pending = client.call('nerStatus');
  const rejected = expect(pending).rejects.toThrow('解析セッションは終了しました');
  client.terminate();
  await rejected;
  expect(terminate).toHaveBeenCalledOnce();
  await expect(client.call('nerStatus')).rejects.toThrow('解析セッションは終了しました');
  expect(postMessage).toHaveBeenCalledOnce();
});
