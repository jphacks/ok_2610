import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { OutputSegment } from '../../src/core/model/types';
import { parseXlsx, type SpreadsheetSource } from '../../src/infra/spreadsheet';
import { exportSpreadsheet, mapRanges, maskedFileName, safeSheetName } from '../../src/infra/spreadsheet-export';
import { run } from './helpers';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 書式・テーブル・コメント・画像・外部リンク・ファイル情報を含むブック */
function richWorkbook() {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="wb"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="ws"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="sst"/><Override PartName="/xl/styles.xml" ContentType="st"/>' +
        '<Override PartName="/xl/tables/table1.xml" ContentType="tb"/><Override PartName="/xl/comments1.xml" ContentType="cm"/>' +
        '<Override PartName="/xl/calcChain.xml" ContentType="cc"/><Override PartName="/docProps/core.xml" ContentType="core"/></Types>',
    ),
    '_rels/.rels': strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="core" Target="docProps/core.xml"/></Relationships>`,
    ),
    'docProps/core.xml': strToU8('<cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:creator>山田太郎</dc:creator></cp:coreProperties>'),
    'xl/workbook.xml': strToU8(
      `<workbook ${NS}><fileSharing userName="山田太郎"/><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="顧客" sheetId="1" r:id="rId1"/></sheets>` +
        `<definedNames><definedName name="範囲">顧客!$A$1:$B$3</definedName></definedNames></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId4" Type="${REL}/calcChain" Target="calcChain.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(`<styleSheet ${NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="0" fontId="1"/></cellXfs></styleSheet>`),
    'xl/sharedStrings.xml': strToU8(
      `<sst ${NS} count="4" uniqueCount="4"><si><t>名前</t></si><si><t>メール</t></si><si><t>佐藤</t></si><si><t>sato.hanako@example.co.jp</t></si></sst>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet ${NS}><cols><col min="1" max="2" width="30" customWidth="1"/></cols><sheetData>` +
        '<row r="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1" t="s"><v>3</v></c></row>' +
        '<row r="3"><c r="A3"><f>LEN(B2)</f><v>25</v></c><c r="B3" t="str"><f>B2</f><v>sato.hanako@example.co.jp</v></c></row>' +
        '</sheetData><mergeCells count="1"><mergeCell ref="A4:B4"/></mergeCells>' +
        '<hyperlinks><hyperlink ref="B2" r:id="rId3"/></hyperlinks>' +
        '<headerFooter><oddHeader>作成者 山田太郎</oddHeader></headerFooter>' +
        '<legacyDrawing r:id="rId2"/><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>',
    ),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>` +
        `<Relationship Id="rId3" Type="${REL}/hyperlink" Target="mailto:sato.hanako@example.co.jp" TargetMode="External"/>` +
        `<Relationship Id="rId4" Type="${REL}/comments" Target="../comments1.xml"/></Relationships>`,
    ),
    'xl/tables/table1.xml': strToU8(
      `<table ${NS} id="1" name="表1" displayName="表1" ref="A1:B3"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="名前"/><tableColumn id="2" name="メール"/></tableColumns></table>`,
    ),
    'xl/comments1.xml': strToU8(`<comments ${NS}><authors><author>山田太郎</author></authors></comments>`),
    'xl/drawings/vmlDrawing1.vml': strToU8('<xml/>'),
    'xl/media/image1.png': new Uint8Array([1, 2, 3]),
    'xl/calcChain.xml': strToU8(`<calcChain ${NS}><c r="A3" i="1"/><c r="B3"/></calcChain>`),
  });
}

async function exportOf(bytes: Uint8Array, fileName = '顧客.xlsx') {
  const imported = parseXlsx(bytes, fileName);
  const result = await run(imported.text);
  const out = exportSpreadsheet(imported.source, result.segments);
  return { imported, result, out, files: unzipSync(out.bytes) };
}

describe('exportSpreadsheet（xlsx）', () => {
  it('加工したセルだけを書き換え、書式とシート構成を残す', async () => {
    const { result, out, files } = await exportOf(richWorkbook());
    expect(result.masked).not.toContain('sato.hanako@example.co.jp');
    expect(out.fileName).toBe('顧客_加工済み.xlsx');

    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    // 変わっていないセルは元のまま
    expect(sheet).toContain('<c r="A1" s="1" t="s"><v>0</v></c>');
    expect(sheet).toContain('<cols><col min="1" max="2" width="30" customWidth="1"/></cols>');
    expect(sheet).toContain('<mergeCell ref="A4:B4"/>');
    // 加工したセルは書式（s）を残して文字列に
    expect(sheet).toMatch(/<c r="B2" s="1" t="inlineStr"><is><t xml:space="preserve">[^<]+<\/t><\/is><\/c>/);
    // 数式の結果に個人情報が出ていたセルは、加工後の値に置き換える
    expect(sheet).toMatch(/<c r="B3" t="inlineStr">/);
    expect(out.notes.join('\n')).toMatch(/数式のセルは、計算結果の値に置き換えました/);

    // 書き出したファイルを読み直すと、加工後の文章と一致する
    expect(parseXlsx(out.bytes).text).toBe(result.masked);
  });

  it('元の値・作成者・外部リンク・検査していない部品をファイルに残さない', async () => {
    const { out, files } = await exportOf(richWorkbook());
    const all = Object.entries(files)
      .map(([, v]) => strFromU8(v, true))
      .join('\n');
    expect(all).not.toContain('sato.hanako@example.co.jp');
    expect(all).not.toContain('山田太郎');

    expect(Object.keys(files).sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        'xl/sharedStrings.xml',
        'xl/styles.xml',
        'xl/tables/table1.xml',
        'xl/workbook.xml',
        'xl/worksheets/_rels/sheet1.xml.rels',
        'xl/worksheets/sheet1.xml',
      ].sort(),
    );
    const types = strFromU8(files['[Content_Types].xml']!);
    expect(types).not.toMatch(/comments1|calcChain|docProps/);
    expect(types).toContain('/xl/tables/table1.xml');
    const sheetRels = strFromU8(files['xl/worksheets/_rels/sheet1.xml.rels']!);
    expect(sheetRels).toContain('../tables/table1.xml');
    expect(sheetRels).not.toMatch(/vmlDrawing|mailto|comments/);
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).not.toMatch(/legacyDrawing|hyperlink|headerFooter/);
    expect(sheet).toContain('<tablePart r:id="rId1"/>');
    expect(strFromU8(files['_rels/.rels']!)).not.toContain('docProps');
    expect(strFromU8(files['xl/_rels/workbook.xml.rels']!)).not.toContain('calcChain');
    // 共有文字列は番号を保ったまま、使われなくなった値だけ空にする
    expect(strFromU8(files['xl/sharedStrings.xml']!)).toContain('<si><t>名前</t></si><si><t>メール</t></si><si><t>佐藤</t></si><si><t/></si>');
    expect(out.notes.join('\n')).toMatch(/コメント・メモは加工後のファイルから取り除きました/);
    expect(out.notes.join('\n')).toMatch(/作成者などのファイル情報/);
  });

  it('テーブルの見出しを加工したら列名も合わせ、シート名の参照も書き換える', async () => {
    const bytes = zipSync({
      'xl/workbook.xml': strToU8(
        `<workbook ${NS}><sheets><sheet name="tanaka@example.com" sheetId="1" r:id="rId1"/><sheet name="集計" sheetId="2" r:id="rId2"/></sheets>` +
          `<definedNames><definedName name="x">'tanaka@example.com'!$A$1</definedName></definedNames></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>090-1234-5678</t></is></c></row></sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`),
      'xl/worksheets/_rels/sheet1.xml.rels': strToU8(`<Relationships><Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/></Relationships>`),
      'xl/tables/table1.xml': strToU8(`<table ${NS} ref="A1:A2"><tableColumns count="1"><tableColumn id="1" name="090-1234-5678"/></tableColumns></table>`),
      'xl/worksheets/sheet2.xml': strToU8(`<worksheet ${NS}><sheetData><row r="1"><c r="A1"><f>'tanaka@example.com'!A1</f><v>1</v></c></row></sheetData></worksheet>`),
    });
    const { out, files } = await exportOf(bytes, 'a.xlsx');
    const all = Object.values(files)
      .map((v) => strFromU8(v))
      .join('\n');
    expect(all).not.toContain('tanaka@example.com');
    expect(all).not.toContain('090-1234-5678');

    const wb = strFromU8(files['xl/workbook.xml']!);
    const newName = /<sheet name="([^"]+)" sheetId="1"/.exec(wb)?.[1] ?? '';
    expect(newName).not.toMatch(/[[\]:*?/\\]/);
    expect(wb).toContain(`<definedName name="x">'${newName}'!$A$1</definedName>`);
    expect(strFromU8(files['xl/worksheets/sheet2.xml']!)).toContain(`<f>'${newName}'!A1</f>`);

    const cell = /<t xml:space="preserve">([^<]+)<\/t>/.exec(strFromU8(files['xl/worksheets/sheet1.xml']!))?.[1];
    expect(strFromU8(files['xl/tables/table1.xml']!)).toContain(`<tableColumn id="1" name="${cell}"/>`);
    expect(out.notes.join('\n')).toMatch(/シート名を加工した/);
  });
});

describe('exportSpreadsheet（csv）', () => {
  it('加工後の文章を BOM 付き UTF-8・CRLF の CSV にする', async () => {
    const source: SpreadsheetSource = { kind: 'csv', fileName: 'list.csv', text: '氏名,メール\n佐藤,sato@example.com\n' };
    const result = await run(source.text);
    const out = exportSpreadsheet(source, result.segments);
    // strFromU8 は先頭の BOM を落とすので、バイト列で確かめる
    expect([...out.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = strFromU8(out.bytes);
    expect(out.fileName).toBe('list_加工済み.csv');
    expect(text.startsWith('氏名,メール\r\n')).toBe(true);
    expect(text).not.toContain('sato@example.com');
    expect(text.replace(/\r\n/g, '\n')).toBe(result.masked);
  });
});

describe('補助関数', () => {
  it('範囲をまたぐ置換は、置換が始まる範囲に入れる', () => {
    const segments: OutputSegment[] = [
      { kind: 'plain', text: 'ab\tc' },
      { kind: 'changed', text: '[X]', original: 'd\te', candidateId: '1' },
      { kind: 'plain', text: 'f' },
    ];
    // 原文 "ab\tcd\tef" のセル: ab / cd / ef
    expect(mapRanges(segments, [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }])).toEqual(['ab', 'c[X]', 'f']);
  });

  it('シート名を Excel の制約に合わせる', () => {
    const used = new Set(['sheet1']);
    expect(safeSheetName('[氏名1]の一覧', used, 0)).toBe('（氏名1）の一覧');
    expect(safeSheetName('', used, 0)).toBe('Sheet1(2)');
    expect(safeSheetName('a'.repeat(40), used, 2)).toHaveLength(31);
  });

  it('ファイル名', () => {
    expect(maskedFileName('顧客.xlsm')).toBe('顧客_加工済み.xlsm');
    expect(maskedFileName('noext')).toBe('noext_加工済み');
  });
});
