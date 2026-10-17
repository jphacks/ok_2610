import { afterEach, expect, test, vi } from 'vitest';
import type { EngineOutput } from '../../src/core/analyze';
import { clearAnalysisSession, sessionNano, workerClient } from '../../src/infra/analysis-session';
import { detectNano } from '../../src/engines/nano';
import { createWorkerClient } from '../../src/infra/worker-client';

vi.mock('../../src/engines/nano', () => ({ detectNano: vi.fn() }));
vi.mock('../../src/infra/worker-client', () => ({ createWorkerClient: vi.fn(() => ({ terminate: vi.fn(), call: vi.fn() })) }));
const result: EngineOutput = { engine: 'nano', status: 'ok', ms: 0, spans: [] };
afterEach(() => { clearAnalysisSession(); vi.clearAllMocks(); });

test('削除は Worker を終了し Nano のキャッシュを消す', async () => {
  vi.mocked(detectNano).mockResolvedValue(result);
  const worker = workerClient();
  await sessionNano('dummy');
  await sessionNano('dummy');
  expect(detectNano).toHaveBeenCalledTimes(1);
  clearAnalysisSession();
  expect(worker.terminate).toHaveBeenCalledOnce();
  workerClient();
  expect(createWorkerClient).toHaveBeenCalledTimes(2);
  await sessionNano('dummy');
  expect(detectNano).toHaveBeenCalledTimes(2);
});

test('削除後に完了した Nano の結果をキャッシュに戻さない', async () => {
  let finish!: (r: EngineOutput) => void;
  vi.mocked(detectNano).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = sessionNano('old-dummy');
  const rejected = expect(pending).rejects.toThrow();
  const signal = vi.mocked(detectNano).mock.calls[0]![1]!;
  clearAnalysisSession();
  expect(signal.aborted).toBe(true);
  finish(result);
  await rejected;
  vi.mocked(detectNano).mockResolvedValue(result);
  await sessionNano('old-dummy');
  expect(detectNano).toHaveBeenCalledTimes(2);
});
