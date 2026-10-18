import { useState } from 'react';
import { ALL_CATEGORIES, categoryLabel } from '../../core/model/categories';
import { countOccurrences, manualMaskOps } from '../../core/manual';
import type { Category, OutputSegment } from '../../core/model/types';
import { Icon } from './Icon';
import { SheetPreview } from './SheetPreview';
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

/** 加工後の各部分が原文のどこから始まるか（加工後の表示で選んだ範囲を原文の位置に戻すため） */
function maskedStarts(segments: OutputSegment[]): { seg: OutputSegment; start: number }[] {
  let pos = 0;
  return segments.map((seg) => {
    const start = pos;
    pos += (seg.kind === 'changed' ? seg.original : seg.text).length;
    return { seg, start };
  });
}

/**
 * 比較プレビュー（FR-20）。加工後の文章は、コピー・挿入される内容と同じ文字列から描く。
 * 原文はこの拡張の画面の中だけに表示する。
 */
export function Preview({ mode, onMode }: { mode: 'masked' | 'original'; onMode: (mode: 'masked' | 'original') => void }) {
  const result = useStore((s) => s.result);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const addOps = useStore((s) => s.addOps);
  const { ops, redo, undo, redoOp } = useStore();
  const source = useStore((s) => s.source);
  const [anchor, setAnchor] = useState<{ start: number; end: number } | null>(null);
  const [term, setTerm] = useState('');
  const [all, setAll] = useState(true);
  const [category, setCategory] = useState<Category>('custom');
  if (!result || !result.text.trim()) return null;

  // 選んだ範囲を入力欄へ写す。前後の空白は隠す対象に含めない
  const onSelect = () => {
    const r = selectionOffsets();
    if (!r) return;
    const raw = result.text.slice(r.start, r.end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const range = { start: r.start + lead, end: r.start + lead + trimmed.length };
    setAnchor(range);
    setTerm(trimmed);
  };
  const needle = term.trim();
  const planned = needle ? manualMaskOps(result.text, needle, category, result.candidates, { all, ...(anchor ? { anchor } : {}) }) : [];
  const total = countOccurrences(result.text, needle);
  const apply = () => {
    addOps(planned);
    setAnchor(null);
    setTerm('');
    window.getSelection()?.removeAllRanges();
  };

  const byId = new Map(result.candidates.map((c) => [c.id, c]));
  // 読み込んだ Excel・CSV は、文章に直さずシートの表として描く
  const sheetSource = source && source.text === result.text ? source : null;

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
        <div className="segmented small" role="group" aria-label="プレビューの切替">
          <button type="button" aria-pressed={mode === 'masked'} className={mode === 'masked' ? 'on' : ''} onClick={() => onMode('masked')}>
            加工後
          </button>
          <button type="button" aria-pressed={mode === 'original'} className={mode === 'original' ? 'on' : ''} onClick={() => onMode('original')}>
            原文
          </button>
        </div>
        <div className="history-actions">
          <button type="button" className="icon-button ghost" onClick={undo} disabled={!ops.length} aria-label="操作を元に戻す" title="操作を元に戻す"><Icon name="undo" /></button>
          <button type="button" className="icon-button ghost" onClick={redoOp} disabled={!redo.length} aria-label="操作をやり直す" title="操作をやり直す"><Icon name="redo" /></button>
        </div>
      </div>

      {sheetSource ? (
        <SheetPreview mode={mode} source={sheetSource} segments={result.segments} candidates={result.candidates} onMouseUp={onSelect} />
      ) : mode === 'masked' ? (
        <div className="doc" aria-label="加工後の文章" onMouseUp={onSelect}>
          {maskedStarts(result.segments).map(({ seg, start }, i) =>
            seg.kind === 'plain' ? (
              <span key={i} data-start={start}>{seg.text}</span>
            ) : (
              <button
                key={i}
                type="button"
                data-start={seg.kind === 'kept' ? start : undefined}
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
        <div className="doc original" aria-label="原文" onMouseUp={onSelect}>
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
      )}
      <div className="manual-mask" role="group" aria-label="手動でマスク">
        <div className="row">
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && planned.length > 0 && apply()}
            placeholder="隠す語（文章を選ぶと入ります）"
            aria-label="手動で隠す語"
          />
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)} aria-label="隠す語の種類">
            {ALL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label className="inline">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            同じ語をすべて
          </label>
          <button type="button" onClick={apply} disabled={planned.length === 0}>
            マスクする{planned.length > 1 ? `（${planned.length}箇所）` : ''}
          </button>
          {anchor || term ? (
            <button type="button" className="ghost" onClick={() => { setAnchor(null); setTerm(''); }}>
              取り消す
            </button>
          ) : null}
        </div>
        <p className="hint">
          {!needle
            ? '加工漏れを見つけたら、文章を選ぶか語を入力して手動でマスクできます。'
            : total === 0
              ? '文章の中に見つかりません。'
              : planned.length === 0
                ? 'すでにすべて加工されています。'
                : planned.length < total && all
                  ? `${total}箇所のうち、まだ加工していない${planned.length}箇所をマスクします。`
                  : null}
        </p>
      </div>
      <p className="hint legend">
        <span className="mark changed">加工</span> <span className="mark kept">残した候補</span> <span className="mark changed manual">手動</span> 色付きの箇所から修正できます。
      </p>
    </div>
  );
}
