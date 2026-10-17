import { beforeEach, expect, test } from 'vitest';
import { canConfirm, canOutput, destinationKey, useStore } from '../../src/ui/store';
import { run } from './helpers';

beforeEach(() => useStore.getState().reset());

async function approve() {
  const s = useStore.getState();
  s.setResult({ ...await run('連絡先は090-1234-5678です。'), policy: { status: 'none' } }, s.revision);
  s.setAnalyzing(false);
  const current = useStore.getState();
  current.confirm({ contentId: current.result!.contentId, masked: current.result!.masked, destinationKey: destinationKey(current.destination) });
  expect(canOutput(useStore.getState())).toBe(true);
}

test.each(['text', 'prefs', 'op', 'ops', 'undo', 'redo', 'answer', 'policy', 'destination'] as const)('%s の変更直後から再確認まで出力を止める', async (change) => {
  const op = { kind: 'add' as const, start: 0, end: 2, category: 'custom' as const };
  if (change === 'undo' || change === 'redo') useStore.getState().addOp(op);
  if (change === 'redo') useStore.getState().undo();
  await approve();
  const s = useStore.getState();
  switch (change) {
    case 'text': s.setText('新しい文章'); break;
    case 'prefs': s.setPrefs({ stage: 'A' }); break;
    case 'op': s.addOp(op); break;
    case 'ops': s.addOps([op]); break;
    case 'undo': s.undo(); break;
    case 'redo': s.redoOp(); break;
    case 'answer': s.setAnswer('rules', 'unknown'); break;
    case 'policy': s.policyChanged(); break;
    case 'destination': s.setDestination({ kind: 'insert', tabId: 1, origin: 'https://chatgpt.com', siteId: 'chatgpt', siteName: 'ChatGPT' }); break;
  }
  expect(canOutput(useStore.getState())).toBe(false);
  if (change !== 'destination') {
    s.confirm(s.confirmed);
    expect(useStore.getState().confirmed).toBeNull();
    s.setResult(s.result, s.revision); // 遅れて届いた古い解析
    expect(canConfirm(useStore.getState())).toBe(false);
  }
});

test('例外が発生したら古い解析の確認・出力を止める', async () => {
  await approve();
  const s = useStore.getState();
  s.setError('Worker failure');
  s.setAnalyzing(false);
  s.confirm(s.confirmed);
  expect(canConfirm(useStore.getState())).toBe(false);
  expect(canOutput(useStore.getState())).toBe(false);
});

test('同じ通知文のポリシー更新でも毎回確認を失効させる', async () => {
  useStore.getState().policyChanged();
  await approve();
  const before = useStore.getState();
  before.policyChanged();
  expect(useStore.getState().revision).toBeGreaterThan(before.revision);
  expect(useStore.getState().notice).toBe(before.notice);
  expect(canOutput(useStore.getState())).toBe(false);
});

test('ポリシーで許可されない挿入先は確認も出力もできない', async () => {
  useStore.getState().setDestination({ kind: 'insert', tabId: 1, origin: 'https://chatgpt.com', siteId: 'chatgpt', siteName: 'ChatGPT' });
  await approve();
  const s = useStore.getState();
  s.setResult({ ...s.result!, policy: { status: 'active', version: 'same', minStage: 'A', requireConditions: false, allowedOrigins: [] } }, s.revision);
  expect(canConfirm(useStore.getState())).toBe(false);
  expect(canOutput(useStore.getState())).toBe(false);
});

test('削除前の遅延結果が新しいセッションへ戻らない', async () => {
  await approve();
  const before = useStore.getState();
  before.reset();
  before.setResult(before.result, before.revision);
  expect(useStore.getState().sessionId).toBeGreaterThan(before.sessionId);
  expect(useStore.getState().result).toBeNull();
  expect(useStore.getState().confirmed).toBeNull();
});
