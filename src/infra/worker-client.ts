import type { WorkerRequest, WorkerResponse, WorkerResponseMap } from '../worker/protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Analysis Worker を Promise で呼ぶ。サイドパネルを閉じれば Worker もメモリ上の原文も消える */
export function createWorkerClient() {
  const worker = new Worker(new URL('../worker/analysis.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let terminated = false;

  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Worker でエラーが起きました'));
    pending.clear();
  };

  function call<T extends WorkerRequest['type']>(
    type: T,
    ...payload: Extract<WorkerRequest, { type: T }> extends { payload: infer P } ? [P] : []
  ): Promise<WorkerResponseMap[T]> {
    if (terminated) return Promise.reject(new Error('解析セッションは終了しました'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, type, ...(payload[0] !== undefined ? { payload: payload[0] } : {}) });
    });
  }

  return { call, terminate: () => {
    terminated = true;
    worker.terminate();
    for (const p of pending.values()) p.reject(new Error('解析セッションは終了しました'));
    pending.clear();
  } };
}

export type WorkerClient = ReturnType<typeof createWorkerClient>;
