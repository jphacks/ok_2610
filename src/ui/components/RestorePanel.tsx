import { useState } from 'react';
import type { RestoreResult } from '../../core/restore';
import { copyText } from '../../infra/clipboard';
import { workerClient } from '../../infra/analysis-session';
import { useStore } from '../store';

/** AIの回答の復元（ARCHITECTURE.md §11-3）。貼付け → 復元 → コピーのみ。AIサイトには挿入しない */
export function RestorePanel() {
  const result = useStore((s) => s.result);
  const current = useStore((s) => !s.analyzing && !s.error && s.resultRevision === s.revision);
  const [answer, setAnswer] = useState('');
  const [restored, setRestored] = useState<RestoreResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!result || (Object.keys(result.restoreMap).length === 0 && Object.keys(result.generalizedMap).length === 0)) return null;

  async function restore() {
    const before = useStore.getState();
    if (!before.result || before.analyzing || before.error || before.resultRevision !== before.revision) return;
    try {
      const value = await workerClient().call('restore', {
        text: answer,
        restoreMap: before.result.restoreMap,
        generalizedMap: before.result.generalizedMap,
      });
      if (useStore.getState().revision === before.revision) setRestored(value);
    } catch {
      if (useStore.getState().revision === before.revision) setMessage('復元できませんでした。もう一度お試しください。');
    }
  }

  return (
    <section className="panel restore-panel" aria-labelledby="restore-title">
      <details>
        <summary>
          <h2 id="restore-title">AIの回答を復元</h2>
          <span className="chip chip-muted">任意</span>
        </summary>
        <p className="hint">「人物A」などのラベルや、「30代」などに一般化した語を元の語に戻します。加工後の文章のほかの所にも同じ語がある一般化と、削除した情報は戻せません。</p>
        <textarea rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="AIの回答を貼り付け" aria-label="AIの回答" />
        <button
          type="button"
          disabled={!answer.trim() || !current}
          onClick={() => void restore()}
        >
          ラベルを元の語に戻す
        </button>
        {restored && (
          <>
            <div className="output-preview" aria-label="元に戻した文章">
              {restored.restored}
            </div>
            <p className="hint">{restored.replacedCount}箇所を戻しました。</p>
            {restored.generalized.length > 0 && (
              <p className="hint">
                一般化から戻した語: {restored.generalized.map((g) => `${g.from}→${g.to}`).join('、')}（AIが一般的な意味で使った語も戻るので、確かめてください）
              </p>
            )}
            {restored.unmatched.length > 0 && <p className="hint warn">戻せなかったラベル: {restored.unmatched.join('、')}（AIが書き換えた可能性があります）</p>}
            <button
              type="button"
              disabled={!current}
              onClick={async () => setMessage((await copyText(restored.restored)) ? 'コピーしました。原文を含むので、外部のサービスには貼り付けないでください。' : 'コピーできませんでした。')}
            >
              コピー
            </button>
            {message && <p className="hint">{message}</p>}
          </>
        )}
      </details>
    </section>
  );
}
