import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { columnIndex, decodeCsv, formatSerialDate, parseXlsx, readSpreadsheetFile, SpreadsheetError } from '../../src/infra/spreadsheet';
import { run } from './helpers';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function workbook(opts: { sheets?: { name: string; xml: string; state?: string }[]; shared?: string[]; styles?: string; extra?: Record<string, string> } = {}) {
  const sheets = opts.sheets ?? [];
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook ${NS}><sheets>${sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.state ? ` state="${s.state}"` : ''}/>`)
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`,
    ),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<worksheet ${NS}><sheetData>${s.xml}</sheetData></worksheet>`)));
  if (opts.shared) files['xl/sharedStrings.xml'] = strToU8(`<sst ${NS}>${opts.shared.join('')}</sst>`);
  if (opts.styles) files['xl/styles.xml'] = strToU8(`<styleSheet ${NS}>${opts.styles}</styleSheet>`);
  for (const [k, v] of Object.entries(opts.extra ?? {})) files[k] = strToU8(v);
  return zipSync(files);
}

describe('parseXlsx', () => {
  it('セルを行ごとにタブ区切りで取り込み、シート名を見出しにする', () => {
    const bytes = workbook({
      shared: ['<si><t>氏名</t></si>', '<si><t>電話</t></si>', '<si><t>田中花子</t></si>'],
      sheets: [
        {
          name: '顧客',
          xml:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="inlineStr"><is><t>090-1234-5678</t></is></c></row>',
        },
      ],
    });
    const { text, notes } = parseXlsx(bytes);
    expect(text).toBe('【シート: 顧客】\n氏名\t電話\n田中花子\t\t090-1234-5678');
    expect(notes).toEqual([]);
  });

  it('リッチテキストをつなぎ、ふりがなは含めない', () => {
    const bytes = workbook({
      shared: ['<si><r><t>山田</t></r><r><rPr><b/></rPr><t>太郎</t></r><rPh sb="0" eb="2"><t>ヤマダ</t></rPh></si>'],
      sheets: [{ name: 'S', xml: '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' }],
    });
    expect(parseXlsx(bytes).text).toBe('【シート: S】\n山田太郎');
  });

  it('日付の表示形式を持つセルは日付として出す', () => {
    const bytes = workbook({
      styles: '<numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="176"/></cellXfs>',
      sheets: [{ name: 'S', xml: '<row r="1"><c r="A1"><v>12.5</v></c><c r="B1" s="1"><v>45322</v></c><c r="C1" s="2"><v>32874</v></c></row>' }],
    });
    expect(parseXlsx(bytes).text).toBe('【シート: S】\n12.5\t2024/01/31\t1990/01/01');
  });

  it('改行やタブを含むセルは引用符で囲み、エンティティを戻す', () => {
    const bytes = workbook({
      sheets: [{ name: 'S', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>東京都\n港区 &amp; "本社"</t></is></c><c r="B1" t="b"><v>1</v></c></row>' }],
    });
    expect(parseXlsx(bytes).text).toBe('【シート: S】\n"東京都\n港区 & ""本社"""\tTRUE');
  });

  it('非表示シートも取り込み、取り込まなかったものを知らせる', () => {
    const bytes = workbook({
      sheets: [
        { name: '表', xml: '<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>' },
        { name: '裏', state: 'hidden', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>秘密</t></is></c></row>' },
      ],
      extra: { 'xl/media/image1.png': 'x', 'xl/comments1.xml': '<comments/>' },
    });
    const { text, notes } = parseXlsx(bytes);
    expect(text).toBe('【シート: 表】\n2\n\n【シート: 裏（非表示）】\n秘密');
    expect(notes.join('\n')).toMatch(/非表示のシート「裏」/);
    expect(notes.join('\n')).toMatch(/画像・コメント・メモは取り込んでいません/);
    expect(notes.join('\n')).toMatch(/数式は計算結果だけ/);
  });

  it('名前空間の接頭辞付きの XML も読める', () => {
    const files = {
      'xl/workbook.xml': strToU8(`<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="A" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8('<x:worksheet xmlns:x="m"><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>佐藤</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>'),
    };
    expect(parseXlsx(zipSync(files)).text).toBe('【シート: A】\n佐藤');
  });

  it('Excel でないファイルは SpreadsheetError', () => {
    expect(() => parseXlsx(strToU8('not a zip'))).toThrow(SpreadsheetError);
    expect(() => parseXlsx(zipSync({ 'a.txt': strToU8('x') }))).toThrow(SpreadsheetError);
  });

  it('取り込んだ文章はそのまま検査にかけられる', async () => {
    const bytes = workbook({
      sheets: [{ name: 'S', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>連絡先</t></is></c><c r="B1" t="inlineStr"><is><t>tanaka@example.co.jp</t></is></c></row>' }],
    });
    const result = await run(parseXlsx(bytes).text);
    expect(result.candidates.some((c) => c.text === 'tanaka@example.co.jp')).toBe(true);
    expect(result.masked).not.toContain('tanaka@example.co.jp');
  });
});

describe('readSpreadsheetFile', () => {
  it('古い .xls と対応外の拡張子は理由付きで断る', async () => {
    await expect(readSpreadsheetFile(new File(['x'], 'a.xls'))).rejects.toThrow(/\.xlsx として保存/);
    await expect(readSpreadsheetFile(new File(['x'], 'a.pdf'))).rejects.toThrow(SpreadsheetError);
  });

  it('CSV は文字コードを判定して読む', async () => {
    const r = await readSpreadsheetFile(new File(['﻿氏名,電話\r\n田中,03-1234-5678\r\n'], 'list.CSV'));
    expect(r.text).toBe('氏名,電話\n田中,03-1234-5678\n');
  });
});

describe('補助関数', () => {
  it('Shift_JIS の CSV を読める', () => {
    // 「田中」の Shift_JIS
    expect(decodeCsv(new Uint8Array([0x93, 0x63, 0x92, 0x86]))).toBe('田中');
  });

  it('列番号と日付シリアル値', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('AB12')).toBe(27);
    expect(formatSerialDate(45322.375)).toBe('2024/01/31 09:00');
    expect(formatSerialDate(0, true)).toBe('1904/01/01');
  });
});
