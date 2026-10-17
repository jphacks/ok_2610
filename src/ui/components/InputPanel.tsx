import { useState } from 'react';
import { MESSAGES } from '../../core/explain/messages';
import { getActiveTab, importSelection } from '../../infra/tabs';
import { useStore } from '../store';

export function InputPanel() {
  const text = useStore((s) => s.text);
  const setText = useStore((s) => s.setText);
  const reset = useStore((s) => s.reset);
  const [message, setMessage] = useState<string | null>(null);

  async function onImport() {
    setMessage(null);
    try {
      const tab = await getActiveTab();
      if (!tab) throw new Error();
      const selected = await importSelection(tab.id);
      if (!selected.trim()) setMessage('ページで文章を選択してから押してください。');
      else setText(selected);
    } catch {
      setMessage('このページの選択テキストは読めませんでした。文章をコピーして貼り付けてください。');
    }
  }

  return (
    <section className="panel" aria-labelledby="input-title">
      <h2 id="input-title">1. 文章</h2>
      <textarea
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="AIに渡す前の文章を貼り付けてください。原文はこの画面の中だけで扱い、外部には送りません。"
        rows={8}
        aria-label="解析する文章"
      />
      <div className="row">
        <button type="button" onClick={onImport}>
          ページの選択テキストを取込
        </button>
        <button type="button" className="ghost" onClick={reset} disabled={!text}>
          終了して削除
        </button>
      </div>
      {message && <p className="hint warn">{message}</p>}
      <p className="hint">{MESSAGES.sessionScope}</p>
    </section>
  );
}
