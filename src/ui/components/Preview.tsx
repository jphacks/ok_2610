import { useState } from 'react';
import { ALL_CATEGORIES, categoryLabel } from '../../core/model/categories';
import type { Category } from '../../core/model/types';
import { useStore } from '../store';

/** 原文の中での選択範囲を、data-start を手がかりに文字位置へ戻す */
function selectionOffsets(): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const pos = (node: Node, offset: number) => {
    const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest<HTMLElement>('[data-start]');
    if (!el) return null;
    return Number(el.dataset.start) + (node.nodeType === Node.TEXT_NODE ? offset : 0);
  };
  const start = pos(range.startContainer, range.startOffset);
  const end = pos(range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

/**
 * 比較プレビュー（FR-20）。加工後の文章は、コピー・挿入される内容と同じ文字列から描く。
 * 原文はこの拡張の画面の中だけに表示する。
 */
export function Preview() {
  const result = useStore((s) => s.result);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const addOp = useStore((s) => s.addOp);
  const [mode, setMode] = useState<'masked' | 'original'>('masked');
  const [pending, setPending] = useState<{ start: number; end: number } | null>(null);
  const [category, setCategory] = useState<Category>('custom');
  if (!result || !result.text.trim()) return null;

  const byId = new Map(result.candidates.map((c) => [c.id, c]));

  const originalChunks: { start: number; text: string; id?: string }[] = [];
  let cursor = 0;
  for (const c of [...result.candidates].sort((a, b) => a.start - b.start)) {
    if (c.start > cursor) originalChunks.push({ start: cursor, text: result.text.slice(cursor, c.start) });
    originalChunks.push({ start: c.start, text: c.text, id: c.id });
    cursor = c.end;
  }
  if (cursor < result.text.length) originalChunks.push({ start: cursor, text: result.text.slice(cursor) });

  return (
    <div className="card preview-card">
      <div className="row between">
        <h3>プレビュー</h3>
        <div className="segmented small" role="group" aria-label="プレビューの切替">
          <button type="button" aria-pressed={mode === 'masked'} className={mode === 'masked' ? 'on' : ''} onClick={() => setMode('masked')}>
            加工後
          </button>
          <button type="button" aria-pressed={mode === 'original'} className={mode === 'original' ? 'on' : ''} onClick={() => setMode('original')}>
            原文
          </button>
        </div>
      </div>

      {mode === 'masked' ? (
        <div className="doc" aria-label="加工後の文章">
          {result.segments.map((seg, i) =>
            seg.kind === 'plain' ? (
              <span key={i}>{seg.text}</span>
            ) : (
              <button
                key={i}
                type="button"
                className={`mark ${seg.kind} ${byId.get(seg.candidateId)?.manual ? 'manual' : ''} ${selectedId === seg.candidateId ? 'selected' : ''}`}
                title={seg.kind === 'changed' ? `元: ${seg.original}` : 'そのまま残しています'}
                onClick={() => select(seg.candidateId)}
              >
                {seg.text || '（削除）'}
              </button>
            ),
          )}
        </div>
      ) : (
        <>
          <div className="doc original" aria-label="原文" onMouseUp={() => setPending(selectionOffsets())}>
            {originalChunks.map((ch) =>
              ch.id ? (
                <span
                  key={ch.start}
                  data-start={ch.start}
                  className={`mark ${byId.get(ch.id)?.output === ch.text ? 'kept' : 'changed'} ${selectedId === ch.id ? 'selected' : ''}`}
                  onClick={() => select(ch.id ?? null)}
                >
                  {ch.text}
                </span>
              ) : (
                <span key={ch.start} data-start={ch.start}>
                  {ch.text}
                </span>
              ),
            )}
          </div>
          {pending ? (
            <div className="row">
              <span className="hint">「{result.text.slice(pending.start, pending.end).slice(0, 20)}」を</span>
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)} aria-label="追加する種類">
                {ALL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabel(c)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  addOp({ kind: 'add', start: pending.start, end: pending.end, category });
                  setPending(null);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                として加工する
              </button>
            </div>
          ) : (
            <p className="hint">見逃しを見つけたら、原文で範囲を選んで追加できます。</p>
          )}
        </>
      )}
      <p className="hint legend">
        <span className="mark changed">加工</span> <span className="mark kept">残した候補</span> <span className="mark changed manual">手動</span> 押すと理由を表示します。
      </p>
    </div>
  );
}
