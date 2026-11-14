import { useEffect, useRef, useState } from 'react';
import { ALL_CATEGORIES, categoryLabel } from '../../core/model/categories';
import { MESSAGES } from '../../core/explain/messages';
import type { Category } from '../../core/model/types';
import { ALWAYS_LOCKED } from '../../core/policy';
import { previewAction } from '../../core/transform/preview';
import { ACTION_CHOICES, actionKey } from '../labels';
import { useStore } from '../store';
import { Icon } from './Icon';
import './review.css';

/**
 * 項目ごとの理由と手動修正（FR-14, FR-19）。
 * 処理は「押すとこう変わる」が一目で分かるよう、仕上がりの見本を書いたボタンで選ぶ（Issue #29）。
 */
export function DetailPanel() {
  const result = useStore((s) => s.result);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const addOp = useStore((s) => s.addOp);
  const [replaceText, setReplaceText] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const c = result?.candidates.find((x) => x.id === selectedId);

  // 押した語のすぐ下に開くので、画面の外にはみ出すときだけ見える位置まで送る
  useEffect(() => {
    if (!selectedId) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ref.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [selectedId]);

  if (!result || !c) return null;
  const ex = result.explanations[c.id];
  const entity = c.entityId ? result.entities.find((e) => e.id === c.entityId) : undefined;
  const others = entity ? result.entities.filter((e) => e.kind === entity.kind && e.id !== entity.id) : [];
  const range = { start: c.start, end: c.end };
  const current = actionKey(c.action);
  const locked = c.categories.some((cat) => ALWAYS_LOCKED.includes(cat));

  // その語に効く処理だけを、仕上がりの見本つきで並べる。仕上がりが同じ選択肢は1つにまとめる
  const seen = new Set<string>();
  const options = ACTION_CHOICES.flatMap((choice) => {
    const output = previewAction(c, choice.action, entity?.label);
    if (output === null) return [];
    const key = output === '' ? '\u0000delete' : output;
    if (seen.has(key) && choice.key !== current) return [];
    seen.add(key);
    return [{ ...choice, output }];
  });
  if (c.action.kind === 'replace') options.unshift({ key: 'replace', label: '指定した語', short: '指定した語', action: c.action, output: c.action.text });

  // AI推定の注記は上のチップと同じことを言うので、重ねて出さない
  const notes = ex ? ex.notes.filter((n) => !(ex.aiInferred && n.includes('AIの推定'))) : [];

  return (
    <div className="card detail" aria-live="polite" ref={ref}>
      <div className="detail-head">
        <h3 className="what">{ex?.what ?? c.text}</h3>
        <button type="button" className="icon-button ghost" onClick={() => select(null)} aria-label="理由を閉じる" title="閉じる">
          <Icon name="close" />
        </button>
      </div>
      {ex?.aiInferred && <span className="chip chip-warn">{MESSAGES.aiInferred}</span>}
      {ex?.why[0] && <p className="why-lead">{ex.why[0]}</p>}

      <div className="options" role="group" aria-label="処理を選ぶ">
        {options.map((o) => {
          const disabled = o.key === 'keep' && locked;
          return (
            <button
              key={o.key}
              type="button"
              className={`option ${o.key === current ? 'on' : ''}`}
              aria-pressed={o.key === current}
              aria-label={`処理を「${o.short}」に変える（仕上がり: ${o.output || '削除'}）`}
              disabled={disabled}
              onClick={() => {
                if (o.key === current) return;
                if (o.key === 'keep') addOp({ kind: 'release', ...range });
                else addOp({ kind: 'setAction', ...range, action: o.action });
              }}
            >
              <span className={`option-out ${o.key === 'keep' ? 'kept' : 'changed'}`}>{o.output || '（削除）'}</span>
              <span className="option-name">{o.short}</span>
            </button>
          );
        })}
      </div>
      {locked && <p className="hint">認証情報は残せません。どの設定でも消します。</p>}
      {notes.length > 0 && (
        <ul className="hint warn notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {ex && (
        <details className="more detail-why">
          <summary>詳しい理由</summary>
          <ul className="why">
            {ex.why.slice(1).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="if-kept"><span>そのまま残すと</span>{ex.ifKept}</p>
        </details>
      )}

      <details className="more detail-more">
        <summary>ほかの直し方</summary>
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
      </details>
    </div>
  );
}
