import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseXlsx } from '../../src/infra/spreadsheet';
import { exportSpreadsheet } from '../../src/infra/spreadsheet-export';
import { recalcOnLoad, restoreCsv, restoredFileName, restoreSpreadsheet } from '../../src/infra/spreadsheet-restore';
import { run } from './helpers';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** AIが作った想定のブック。対応表のラベルを共有文字列・インライン文字列・数式・数値・シート名に含む */
function aiWorkbook(sheetName = '人物Aの対応') {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'xl/workbook.xml': strToU8(
      `<workbook ${NS}><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="範囲">'${sheetName}'!$A$1:$B$4</definedName></definedNames></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(`<sst ${NS}><si><t>担当</t></si><si><t>人物Aが組織Aに連絡する</t></si><si><t>30代</t></si></sst>`),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet ${NS}><cols><col min="1" max="2" width="40" customWidth="1"/></cols><sheetData>` +
        '<row r="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="inlineStr"><is><t>[電話番号1]</t></is></c></row>' +
        '<row r="2"><c r="A2" s="2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="str"><f>A2&amp;"様"</f><v>人物Aが組織Aに連絡する様</v></c></row>' +
        '<row r="4"><c r="A4" t="inlineStr"><is><t>人物Zさん、Aさん</t></is></c></row>' +
        '</sheetData></worksheet>',
    ),
  });
}

const restoreMap = { 人物A: '佐藤花子', 組織A: '青葉商事', '[電話番号1]': '090-1234-5678' };
const generalizedMap = { '30代': '34歳' };

describe('restoreSpreadsheet（xlsx）', () => {
  it('文字のセルとシート名だけを元の語に戻し、書式・数値・数式を残す', () => {
    const { source } = parseXlsx(aiWorkbook(), 'AI回答_加工済み.xlsx');
    const out = restoreSpreadsheet(source, restoreMap, generalizedMap);
    expect(out.fileName).toBe('AI回答_復元済み.xlsx');
    expect(out.cellCount).toBe(3);
    expect(out.generalized).toEqual([{ from: '30代', to: '34歳' }]);
    expect(out.unmatched).toEqual(expect.arrayContaining(['人物Z', 'Aさん']));

    const files = unzipSync(out.bytes);
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<col min="1" max="2" width="40" customWidth="1"/>');
    // 戻したセルは書式を残してインライン文字列に
    expect(sheet).toContain('<c r="A2" s="2" t="inlineStr"><is><t xml:space="preserve">佐藤花子が青葉商事に連絡する</t></is></c>');
    expect(sheet).toContain('<c r="B1" s="1" t="inlineStr"><is><t xml:space="preserve">090-1234-5678</t></is></c>');
    expect(sheet).toContain('<t xml:space="preserve">34歳</t>');
    // 変わらないセル・数値・数式は元のまま
    expect(sheet).toContain('<c r="A1" s="1" t="s"><v>0</v></c>');
    expect(sheet).toContain('<c r="B2"><v>42</v></c>');
    expect(sheet).toContain('<f>A2&amp;"様"</f>');

    const wb = strFromU8(files['xl/workbook.xml']!);
    expect(wb).toContain('name="佐藤花子の対応"');
    expect(wb).toContain("'佐藤花子の対応'!$A$1:$B$4");
    // 数式は開いたときに計算し直す
    expect(wb).toContain('<calcPr fullCalcOnLoad="1"/>');
    expect(wb.indexOf('<calcPr')).toBeGreaterThan(wb.indexOf('</definedNames>'));
    expect(out.notes.join('\n')).toContain('数式');

    // 戻したファイルを読み直しても、セルの値が原文になっている
    expect(parseXlsx(out.bytes).text).toContain('佐藤花子が青葉商事に連絡する');
  });

  it('戻せるラベルがなければ、セルを書き換えない', () => {
    const { source } = parseXlsx(aiWorkbook('Sheet1'), 'book.xlsx');
    const out = restoreSpreadsheet(source, { 人物Q: '山田' });
    expect(out.cellCount).toBe(0);
    expect(out.replacedCount).toBe(0);
    expect(strFromU8(unzipSync(out.bytes)['xl/worksheets/sheet1.xml']!)).not.toContain('xml:space');
  });

  it('加工して保存したファイルを、そのまま元に戻せる', async () => {
    const original = zipSync({
      'xl/workbook.xml': strToU8(`<workbook ${NS}><sheets><sheet name="顧客" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>連絡先 sato.hanako@example.co.jp</t></is></c></row></sheetData></worksheet>`,
      ),
    });
    const imported = parseXlsx(original, '顧客.xlsx');
    const result = await run(imported.text);
    const masked = exportSpreadsheet(imported.source, result.segments);
    expect(parseXlsx(masked.bytes).text).not.toContain('sato.hanako@example.co.jp');

    const restored = restoreSpreadsheet(parseXlsx(masked.bytes, masked.fileName).source, result.restoreMap, result.generalizedMap);
    expect(restored.fileName).toBe('顧客_復元済み.xlsx');
    expect(parseXlsx(restored.bytes).text).toContain('連絡先 sato.hanako@example.co.jp');
  });
});

describe('restoreSpreadsheet（CSV）', () => {
  it('欄ごとに戻し、区切りを含む値は引用符で囲む', () => {
    const text = '担当,メモ\n人物A,"組織Aと""相談"""\n[住所1],x\n';
    const out = restoreSpreadsheet({ kind: 'csv', fileName: 'ai.csv', text }, { ...restoreMap, '[住所1]': '東京都港区1-2, 3階' });
    expect(out.cellCount).toBe(3);
    const csv = strFromU8(out.bytes);
    // strFromU8 は先頭の BOM を落とすので、バイト列で確かめる
    expect([...out.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv).toBe('担当,メモ\r\n佐藤花子,"青葉商事と""相談"""\r\n"東京都港区1-2, 3階",x\r\n');
  });

  it('引用符の中の改行と区切りは区切りとみなさない', () => {
    expect(restoreCsv('"a,人物A\nb",c', (v) => v.replace('人物A', 'X'))).toBe('"a,X\nb",c');
    expect(restoreCsv('', (v) => v)).toBe('');
    expect(restoreCsv(',,\n', (v) => v)).toBe(',,\n');
  });
});

describe('restoredFileName', () => {
  it('加工済みの印を復元済みに置き換える', () => {
    expect(restoredFileName('顧客_加工済み.xlsx')).toBe('顧客_復元済み.xlsx');
    expect(restoredFileName('回答.csv')).toBe('回答_復元済み.csv');
    expect(restoredFileName('noext')).toBe('noext_復元済み');
  });
});

describe('recalcOnLoad', () => {
  it('既存の calcPr に付け足す', () => {
    expect(recalcOnLoad('<workbook><sheets/><calcPr calcId="191029"/></workbook>')).toBe('<workbook><sheets/><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
    expect(recalcOnLoad('<x:workbook><x:sheets></x:sheets><x:extLst/></x:workbook>')).toBe('<x:workbook><x:sheets></x:sheets><x:calcPr fullCalcOnLoad="1"/><x:extLst/></x:workbook>');
  });
});
