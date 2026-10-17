import type { EngineOutput } from '../core/analyze';
import { detectNano } from '../engines/nano';
import { createWorkerClient, type WorkerClient } from './worker-client';

let client: WorkerClient | null = null;
let controller = new AbortController();
const nanoCache = new Map<string, EngineOutput>();

export function workerClient(): WorkerClient {
  client ??= createWorkerClient();
  return client;
}

export async function sessionNano(text: string): Promise<EngineOutput> {
  const signal = controller.signal;
  const result = nanoCache.get(text) ?? await detectNano(text, signal);
  signal.throwIfAborted();
  if (result.status === 'ok') {
    nanoCache.set(text, result);
    if (nanoCache.size > 5) nanoCache.delete(nanoCache.keys().next().value!);
  }
  return result;
}

/** 削除時に推論を止め、原文を保持するキャッシュごと Worker を破棄する。 */
export function clearAnalysisSession(): void {
  controller.abort();
  controller = new AbortController();
  nanoCache.clear();
  client?.terminate();
  client = null;
}
