import { useState } from 'react';
import type { Candidate, OutputSegment } from '../../core/model/types';
import { buildGrid, columnName, MAX_GRID_COLS, MAX_GRID_ROWS, type GridCell, type GridPart } from '../../infra/spreadsheet-grid';
import type { SpreadsheetSource } from '../../infra/spreadsheet';
import { useStore } from '../store';

/**
 * 読み込んだ Excel・CSV の比較プレビュー。文章ではなく、シートの表として描く。
 * 加工後のセルの値は、元と同じ形式で保存したときと同じになる。
 */
export function SheetPreview({
  mode,
  source,
  segments,
  candidates,
  onMouseUp,
}: {
  mode: 'masked' | 'original';
  source: SpreadsheetSource;
  segments: OutputSegment[];
  candidates: Candidate[];
  onMouseUp: () => void;
}) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const [index, setIndex] = useState(0);
  const sheets = buildGrid(source, segments);
  const sheet = sheets[Math.min(index, sheets.length - 1)];
  if (!sheet) return null;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const unquote = (cell: GridCell | null, text: string) => (cell?.quoted ? text.replace(/""/g, '"') : text);

  function renderParts(parts: GridPart[], cell: GridCell | null) {
    return parts.map((p, i) => {
      if (p.kind === 'plain') {
        return (
          <span key={i} data-start={cell?.quoted ? undefined : p.start}>
            {unquote(cell, p.text)}
          </span>
        );
      }
      const cls = `mark ${p.kind} ${byId.get(p.candidateId)?.manual ? 'manual' : ''} ${selectedId === p.candidateId ? 'selected' : ''}`;
      if (mode === 'original') {
        return (
          <span key={i} data-start={cell?.quoted ? undefined : p.start} className={cls} onClick={() => select(p.candidateId)}>
            {unquote(cell, p.text)}
          </span>
        );
      }
      return (
        <button key={i} type="button" className={cls} title={p.kind === 'changed' ? `元: ${p.original}` : 'そのまま残しています'} onClick={() => select(p.candidateId)}>
          {unquote(cell, p.text) || '（削除）'}
        </button>
      );
    });
  }

  const sheetLabel = (s: (typeof sheets)[number]) => {
    if (!s.name) return s.label;
    const parts = mode === 'masked' ? s.name : null;
    return parts ? parts.map((p) => p.text).join('') || s.label : s.label;
  };
  const nameChanged = (s: (typeof sheets)[number]) => s.name?.some((p) => p.kind === 'changed') ?? false;
  const cols = Array.from({ length: Math.max(sheet.colCount, 1) }, (_, i) => i);

  return (
    <div className="sheet-preview">
      {source.kind === 'xlsx' && (
        <div className="sheet-tabs" role="tablist" aria-label="シート">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={s === sheet}
              className={`sheet-tab ${s === sheet ? 'on' : ''} ${mode === 'masked' && nameChanged(s) ? 'changed' : ''}`}
              title={mode === 'masked' && nameChanged(s) ? `元: ${s.label}` : undefined}
              onClick={() => setIndex(i)}
            >
              {sheetLabel(s)}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-scroll" aria-label={mode === 'masked' ? '加工後の文章' : '原文'} onMouseUp={mode === 'original' ? onMouseUp : undefined}>
        {sheet.rows.length === 0 ? (
          <p className="hint sheet-empty">文字の入ったセルはありません。</p>
        ) : (
          <table className="sheet">
            <thead>
              <tr>
                <th className="corner" aria-hidden="true" />
                {cols.map((c) => (
                  <th key={c} scope="col">
                    {columnName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((r) => {
                const byCol = new Map(r.cells.map((c) => [c.col, c]));
                return (
                  <tr key={r.row}>
                    <th scope="row">{r.row + 1}</th>
                    {cols.map((c) => {
                      const cell = byCol.get(c) ?? null;
                      return <td key={c}>{cell ? renderParts(mode === 'masked' ? cell.masked : cell.original, cell) : null}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {sheet.truncated && (
        <p className="hint">
          表示は先頭 {MAX_GRID_ROWS} 行・{MAX_GRID_COLS} 列までです。検査と保存はすべてのセルに対して行います。
        </p>
      )}
    </div>
  );
}
