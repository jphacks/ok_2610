import { useState } from 'react';
import { ALL_CATEGORIES, categoryLabel } from '../../core/model/categories';
import { MESSAGES } from '../../core/explain/messages';
import type { Category } from '../../core/model/types';
import { ACTION_CHOICES, actionKey } from '../labels';
import { useStore } from '../store';

/** 項目ごとの理由と手動修正（FR-14, FR-19） */
export function DetailPanel() {
  const result = useStore((s) => s.result);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const addOp = useStore((s) => s.addOp);
  const [replaceText, setReplaceText] = useState('');
  const c = result?.candidates.find((x) => x.id === selectedId);
  if (!result || !c) return null;
  const ex = result.explanations[c.id];
  const entity = c.entityId ? result.entities.find((e) => e.id === c.entityId) : undefined;
  const others = entity ? result.entities.filter((e) => e.kind === entity.kind && e.id !== entity.id) : [];
  const range = { start: c.start, end: c.end };

  return (
    <div className="card detail" aria-live="polite">
      <div className="row between">
        <h3>理由</h3>
        <button type="button" className="ghost" onClick={() => select(null)} aria-label="理由を閉じる">
          閉じる
        </button>
      </div>
      {ex && (
        <>
          <p className="what">{ex.what}</p>
          {ex.aiInferred && <span className="chip chip-warn">{MESSAGES.aiInferred}</span>}
          <h4>なぜ</h4>
          <ul>
            {ex.why.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <h4>そのまま残すと</h4>
          <p>{ex.ifKept}</p>
          {ex.notes.length > 0 && (
            <ul className="notes">
              {ex.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <h4>ほかの選択肢</h4>
          <p className="hint">{ex.alternatives.join(' / ')}</p>
        </>
      )}

      <h4>処理を変える</h4>
      <div className="row">
        <select
          aria-label="処理"
          value={actionKey(c.action)}
          onChange={(e) => {
            const choice = ACTION_CHOICES.find((a) => a.key === e.target.value);
            if (choice) addOp({ kind: 'setAction', ...range, action: choice.action });
          }}
        >
          {ACTION_CHOICES.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
          {c.action.kind === 'replace' && <option value="replace">置換語: {c.action.text}</option>}
        </select>
        <button type="button" onClick={() => addOp({ kind: 'release', ...range })} disabled={c.action.kind === 'keep'}>
          解除（残す）
        </button>
      </div>
      <div className="row">
        <input value={replaceText} onChange={(e) => setReplaceText(e.target.value)} placeholder="置換語を入力" aria-label="置換語" />
        <button
          type="button"
          disabled={!replaceText.trim()}
          onClick={() => {
            addOp({ kind: 'setAction', ...range, action: { kind: 'replace', text: replaceText.trim() } });
            setReplaceText('');
          }}
        >
          置き換える
        </button>
      </div>
      <div className="row">
        <label className="inline">
          種類の訂正
          <select
            value={c.categories[0]}
            onChange={(e) => addOp({ kind: 'setCategory', ...range, category: e.target.value as Category })}
          >
            {ALL_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {categoryLabel(cat)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {entity && (
        <div className="row">
          <span className="hint">
            {entity.label}（{entity.mentionIds.length}箇所）
          </span>
          {others.length > 0 && (
            <select
              aria-label="同じ対象として統合"
              value=""
              onChange={(e) => e.target.value && addOp({ kind: 'mergeEntity', from: c.text, into: e.target.value })}
            >
              <option value="">同じ対象として統合…</option>
              {others.map((o) => (
                <option key={o.id} value={o.canonical}>
                  {o.label}（{o.canonical}）
                </option>
              ))}
            </select>
          )}
          {entity.mentionIds.length > 1 && (
            <button type="button" className="ghost" onClick={() => addOp({ kind: 'splitEntity', ...range })}>
              この箇所を別の対象にする
            </button>
          )}
        </div>
      )}
    </div>
  );
}
