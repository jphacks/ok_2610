import type { OutputSegment } from '../core/model/types';
import type { SpreadsheetSource } from './spreadsheet';

// 読み込んだ Excel・CSV を、プレビューで表として描くための形にする。
// 解析は文章（source.text）に対して行うので、加工結果を各セルの範囲で切り分けて表に戻す。
// 加工後のセルの値は、保存（spreadsheet-export.ts の mapRanges）と同じ規則で決める。

/** 原文上の位置 start から始まる断片。kind が plain 以外なら候補に対応する */
export type GridPart =
  | { kind: 'plain'; text: string; start: number }
  | { kind: 'changed' | 'kept'; text: string; start: number; candidateId: string; original: string };

export type GridCell = { col: number; masked: GridPart[]; original: GridPart[]; quoted: boolean };
export type GridRow = { row: number; cells: GridCell[] };
export type GridSheet = { name: GridPart[] | null; label: string; rows: GridRow[]; colCount: number; truncated: boolean };

/** 表として描く上限。超えた分は描かない（検査と保存は全体に対して行う） */
export const MAX_GRID_ROWS = 500;
export const MAX_GRID_COLS = 50;

type Range = { start: number; end: number };
type CellRange = Range & { row: number; col: number; quoted: boolean };
type SheetRanges = { label: string; name: Range | null; cells: CellRange[] };

export function buildGrid(source: SpreadsheetSource, segments: OutputSegment[]): GridSheet[] {
  const sheets: SheetRanges[] =
    source.kind === 'csv'
      ? [{ label: source.fileName, name: null, cells: csvCells(source.text) }]
      : source.sheets.map((s) => ({
          label: s.name,
          name: { start: s.nameStart, end: s.nameEnd },
          cells: s.cells.map((c) => ({ start: c.textStart, end: c.textEnd, row: c.row, col: c.col, quoted: c.quoted })),
        }));

  const ranges: Range[] = [];
  for (const s of sheets) {
    if (s.name) ranges.push(s.name);
    ranges.push(...s.cells);
  }
  const parts = mapParts(segments, ranges);

  let k = 0;
  return sheets.map((s) => {
    const name = s.name ? (parts[k++] ?? null) : null;
    const rows: GridRow[] = [];
    let colCount = 0;
    let truncated = false;
    for (const c of s.cells) {
      const p = parts[k++];
      if (!p) continue;
      if (c.col >= MAX_GRID_COLS) {
        truncated = true;
        continue;
      }
      let last = rows.at(-1);
      if (!last || last.row !== c.row) {
        if (rows.length >= MAX_GRID_ROWS) {
          truncated = true;
          continue;
        }
        last = { row: c.row, cells: [] };
        rows.push(last);
      }
      last.cells.push({ col: c.col, masked: p.masked, original: p.original, quoted: c.quoted });
      colCount = Math.max(colCount, c.col + 1);
    }
    return { name: name ? name.masked : null, label: s.label, rows, colCount, truncated };
  });
}

/**
 * 各範囲について、加工後と原文の断片を求める。範囲は原文の先頭から順に並んでいること。
 * 範囲をまたぐ置換は、保存と同じく置換が始まる範囲にまとめて入れる。
 */
export function mapParts(segments: OutputSegment[], ranges: Range[]): { masked: GridPart[]; original: GridPart[] }[] {
  const outs = ranges.map(() => ({ masked: [] as GridPart[], original: [] as GridPart[] }));
  let pos = 0;
  let k = 0;
  for (const seg of segments) {
    const orig = seg.kind === 'changed' ? seg.original : seg.text;
    const start = pos;
    const end = pos + orig.length;
    pos = end;
    while (k < ranges.length && (ranges[k]?.end ?? 0) <= start) k++;
    let placed = false;
    for (let j = k; j < ranges.length; j++) {
      const r = ranges[j];
      const out = outs[j];
      if (!r || !out || r.start >= end) break;
      const a = Math.max(r.start, start);
      const b = Math.min(r.end, end);
      const piece = orig.slice(a - start, b - start);
      if (seg.kind === 'plain') {
        if (b > a) {
          out.original.push({ kind: 'plain', text: piece, start: a });
          out.masked.push({ kind: 'plain', text: piece, start: a });
        }
        continue;
      }
      if (b > a) out.original.push({ kind: seg.kind, text: piece, start: a, candidateId: seg.candidateId, original: seg.kind === 'changed' ? seg.original : seg.text });
      if (seg.kind === 'kept') {
        if (b > a) out.masked.push({ kind: 'kept', text: piece, start: a, candidateId: seg.candidateId, original: seg.text });
      } else if (!placed) {
        out.masked.push({ kind: 'changed', text: seg.text, start, candidateId: seg.candidateId, original: seg.original });
        placed = true;
      }
    }
  }
  return outs;
}

/** CSV の各セルの位置。" で囲まれたセルは中身だけを範囲にする。区切りは1行目に , が無く タブがあればタブ */
export function csvCells(text: string): CellRange[] {
  const firstLine = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const sep = !firstLine.includes(',') && firstLine.includes('\t') ? '\t' : ',';
  const cells: CellRange[] = [];
  let i = 0;
  let row = 0;
  let col = 0;
  while (i <= text.length) {
    let start: number;
    let end: number;
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      start = i + 1;
      let j = start;
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') j += 2;
        else if (text[j] === '"') break;
        else j++;
      }
      end = j;
      i = j + 1;
      // 閉じた " の後ろに区切りまで文字があれば、それもセルの値として含める
      while (i < text.length && text[i] !== sep && text[i] !== '\n') i++;
      if (i > end + 1) end = i;
    } else {
      start = i;
      while (i < text.length && text[i] !== sep && text[i] !== '\n') i++;
      end = i;
    }
    if (end > start) cells.push({ start, end, row, col, quoted });
    if (i >= text.length) break;
    if (text[i] === sep) col++;
    else {
      row++;
      col = 0;
    }
    i++;
  }
  return cells;
}

/** 0 → A, 26 → AA */
export function columnName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
