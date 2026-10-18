import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { OutputSegment } from '../../src/core/model/types';
import { decodeCsv, parseXlsx, type SpreadsheetSource } from '../../src/infra/spreadsheet';
import { exportSpreadsheet } from '../../src/infra/spreadsheet-export';
import { buildGrid, columnName, csvCells, mapParts } from '../../src/infra/spreadsheet-grid';
import { run } from './helpers';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function book(rows: string) {
  return zipSync({
    'xl/workbook.xml': strToU8(`<workbook ${NS}><sheets><sheet name="顧客" sheetId="1" r:id="rId1"/><sheet name="空" sheetId="2" r:id="rId2"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`),
    'xl/worksheets/sheet2.xml': strToU8(`<worksheet ${NS}><sheetData/></worksheet>`),
  });
}

const cell = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
const cellText = (parts: { text: string }[]) => parts.map((p) => p.text).join('');

describe('buildGrid', () => {
  it('xlsx のセルを行・列の位置のまま表にし、加工後の値は保存した値と一致する', async () => {
    const bytes = book(`<row r="1">${cell('A1', '名前')}${cell('C1', 'メール')}</row><row r="3">${cell('A3', '佐藤')}${cell('C3', 'sato.hanako@example.co.jp')}</row>`);
    const { source } = parseXlsx(bytes, '顧客.xlsx');
    const result = await run(source.text);
    const [sheet, empty] = buildGrid(source, result.segments);

    expect(sheet?.label).toBe('顧客');
    expect(sheet?.colCount).toBe(3);
    expect(sheet?.rows.map((r) => r.row)).toEqual([0, 2]);
    expect(sheet?.rows[1]?.cells.map((c) => c.col)).toEqual([0, 2]);
    const mail = sheet?.rows[1]?.cells[1];
    expect(cellText(mail?.original ?? [])).toBe('sato.hanako@example.co.jp');
    expect(cellText(mail?.masked ?? [])).not.toContain('sato.hanako');
    expect(mail?.masked.some((p) => p.kind === 'changed')).toBe(true);
    expect(empty?.rows).toEqual([]);

    // 表に出した加工後の値が、元と同じ形式で保存したファイルのセルと同じになる
    const out = unzipSync(exportSpreadsheet(source, result.segments).bytes);
    expect(strFromU8(out['xl/worksheets/sheet1.xml']!)).toContain(cellText(mail?.masked ?? []));
  });

  it('原文の断片は文章上の位置を持つ（範囲を選んで追加できる）', async () => {
    const { source } = parseXlsx(book(`<row r="1">${cell('A1', 'メモ')}${cell('B1', '電話は080-9876-5432です')}</row>`));
    const result = await run(source.text);
    const parts = buildGrid(source, result.segments)[0]?.rows[0]?.cells[1]?.original ?? [];
    for (const p of parts) expect(source.text.slice(p.start, p.start + p.text.length)).toBe(p.text);
  });

  it('CSV は1枚の表として描く', async () => {
    const text = decodeCsv(strToU8('名前,メール\n佐藤,"sato.hanako@example.co.jp"\n'));
    const source: SpreadsheetSource = { kind: 'csv', fileName: '顧客.csv', text };
    const result = await run(text);
    const [sheet] = buildGrid(source, result.segments);
    expect(sheet?.label).toBe('顧客.csv');
    expect(sheet?.name).toBeNull();
    expect(sheet?.rows.map((r) => r.cells.map((c) => c.col))).toEqual([[0, 1], [0, 1]]);
    expect(cellText(sheet?.rows[1]?.cells[1]?.masked ?? [])).not.toContain('sato.hanako');
  });
});

describe('mapParts', () => {
  it('セルをまたぐ置換は、置換が始まるセルにまとめて入れる（保存と同じ規則）', () => {
    const segments: OutputSegment[] = [
      { kind: 'plain', text: 'a' },
      { kind: 'changed', text: '[X]', original: 'b\tc', candidateId: 'x' },
      { kind: 'plain', text: 'd' },
    ];
    const outs = mapParts(segments, [
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
    expect(cellText(outs[0]?.masked ?? [])).toBe('a[X]');
    expect(cellText(outs[1]?.masked ?? [])).toBe('d');
    expect(cellText(outs[0]?.original ?? [])).toBe('ab');
    expect(cellText(outs[1]?.original ?? [])).toBe('cd');
  });
});

describe('csvCells', () => {
  it('引用符で囲まれたセルは中身だけを範囲にし、空のセルは飛ばす', () => {
    const text = 'a,"b,""c""",\n"改\n行",x';
    const cells = csvCells(text);
    expect(cells.map((c) => [c.row, c.col, text.slice(c.start, c.end), c.quoted])).toEqual([
      [0, 0, 'a', false],
      [0, 1, 'b,""c""', true],
      [1, 0, '改\n行', true],
      [1, 1, 'x', false],
    ]);
  });

  it('1行目にカンマが無くタブがあれば、タブ区切りとして読む', () => {
    expect(csvCells('a\tb\nc\td').map((c) => [c.row, c.col])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });
});

it('columnName', () => {
  expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
});
