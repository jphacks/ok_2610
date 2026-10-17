import { analyze, type EngineOutput } from '../core/analyze';
import { resolvePolicy, type ResolvedPolicy } from '../core/policy';
import { restoreLabels } from '../core/restore';
import { detectNer, nerAvailability } from '../engines/ner';
import type { PolicySummary, WorkerRequest, WorkerResponse } from './protocol';

// 判定の中核（core/）と、規則・NER エンジンを動かす専用 Worker。
// 原文と対応表はこの Worker とサイドパネルのメモリにだけ置き、保存しない。

const NER_CACHE_SIZE = 5;
const nerCache = new Map<string, EngineOutput>();

async function nerFor(text: string): Promise<EngineOutput> {
  const hit = nerCache.get(text);
  if (hit) return hit;
  const out = await detectNer(text);
  if (out.status === 'ok') {
    nerCache.set(text, out);
    if (nerCache.size > NER_CACHE_SIZE) nerCache.delete(nerCache.keys().next().value as string);
  }
  return out;
}

function summarize(policy: ResolvedPolicy): PolicySummary {
  if (policy.status !== 'active') return policy;
  return {
    status: 'active',
    version: policy.version,
    ...(policy.name ? { name: policy.name } : {}),
    ...(policy.contact ? { contact: policy.contact } : {}),
    ...(policy.allowedOrigins ? { allowedOrigins: policy.allowedOrigins } : {}),
    minStage: policy.minStage,
    requireConditions: policy.requireConditions,
  };
}

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  switch (req.type) {
    case 'analyze': {
      const { text, settings, ops, policyRaw, nowIso, conditions, nano } = req.payload;
      const policy = resolvePolicy(policyRaw, nowIso);
      const profile = new Set([...settings.profile, ...(policy.status === 'active' ? policy.minProfile : [])]);
      const engineOutputs: EngineOutput[] = [];
      if (profile.has('ner') && text.trim()) engineOutputs.push(await nerFor(text));
      if (nano) engineOutputs.push(nano);
      const result = await analyze({ text, settings, ops, engineOutputs, policy, conditions });
      return { id: req.id, ok: true, result: { ...result, policy: summarize(policy) } };
    }
    case 'restore':
      return { id: req.id, ok: true, result: restoreLabels(req.payload.text, req.payload.restoreMap) };
    case 'nerStatus':
      return { id: req.id, ok: true, result: await nerAvailability() };
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  let res: WorkerResponse;
  try {
    res = await handle(e.data);
  } catch (err) {
    res = { id: e.data.id, ok: false, error: err instanceof Error ? err.message : '不明なエラー' };
  }
  self.postMessage(res);
};
