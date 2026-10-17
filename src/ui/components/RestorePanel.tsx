import { useState } from 'react';
import type { RestoreResult } from '../../core/restore';
import { copyText } from '../../infra/clipboard';
import { workerClient } from '../useAnalysis';
import { useStore } from '../store';

/** AIの回答の復元（ARCHITECTURE.md §11-3）。貼付け → 復元 → コピーのみ。AIサイトには挿入しない */
export function RestorePanel() {
  const result = useStore((s) => s.result);
  const [answer, setAnswer] = useState('');
  const [restored, setRestored] = useState<RestoreResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!result || Object.keys(result.restoreMap).length === 0) return null;

  return (
    <section className="panel restore-panel" aria-labelledby="restore-title">
      <details>
        <summary>
          <h2 id="restore-title">5. AIの回答を元に戻す</h2>
          <span className="chip chip-muted">AIを使ったあとに</span>
        </summary>
        <p className="hint">AIの回答を貼り付けると、「人物A」などの仮ラベルを元の語に戻します。対応表はこの画面の外に出しません。年代などに一般化した情報は戻りません。</p>
        <textarea rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="AIの回答を貼り付け" aria-label="AIの回答" />
        <button
          type="button"
          disabled={!answer.trim()}
          onClick={async () => setRestored(await workerClient().call('restore', { text: answer, restoreMap: result.restoreMap }))}
        >
          ラベルを元の語に戻す
        </button>
        {restored && (
          <>
            <div className="output-preview" aria-label="元に戻した文章">
              {restored.restored}
            </div>
            <p className="hint">{restored.replacedCount}箇所を戻しました。</p>
            {restored.unmatched.length > 0 && <p className="hint warn">戻せなかったラベル: {restored.unmatched.join('、')}（AIが書き換えた可能性があります）</p>}
            <button
              type="button"
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
