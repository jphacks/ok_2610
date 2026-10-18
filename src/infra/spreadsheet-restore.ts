import { strToU8, zipSync } from 'fflate';
import { restoreLabels, type RestoreResult } from '../core/restore';
import { renameSheets, syncTables, writeCell } from './spreadsheet-export';
import { unzipXlsx, type SpreadsheetSource } from './spreadsheet';

// AIが作った・手を加えた Excel・CSV のセルにある仮ラベルと一般化した語を、対応表で原文の語に戻す（ARCHITECTURE.md §11-3）。
// 加工して AI に渡したファイルと同じ形である必要はない。セルごとに restoreLabels を当て、変わったセルとシート名だけを書き換える。
// 戻したファイルは原文を含むので、端末に保存するだけにする（AIサイトには挿入しない）。

export type SpreadsheetRestore = Omit<RestoreResult, 'restored'> & {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  /** 戻したセルの数 */
  cellCount: number;
  notes: string[];
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSM_MIME = 'application/vnd.ms-excel.sheet.macroEnabled.12';

/** 「顧客_加工済み.xlsx」→「顧客_復元済み.xlsx」、「回答.xlsx」→「回答_復元済み.xlsx」 */
export function restoredFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  return `${base.endsWith('_加工済み') ? base.slice(0, -'_加工済み'.length) : base}_復元済み${ext}`;
}

/** 複数のセルの復元結果をまとめる */
class Tally {
  replacedCount = 0;
  cellCount = 0;
  private generalized = new Map<string, string>();
  private unmatched = new Set<string>();

  constructor(
    private restoreMap: Record<string, string>,
    private generalizedMap: Record<string, string>,
  ) {}

  /** 戻した値を返すだけで、数には入れない */
  peek(value: string): string {
    return restoreLabels(value, this.restoreMap, this.generalizedMap).restored;
  }

  restore(value: string): string {
    const r = restoreLabels(value, this.restoreMap, this.generalizedMap);
    this.replacedCount += r.replacedCount;
    for (const g of r.generalized) this.generalized.set(g.from, g.to);
    for (const u of r.unmatched) this.unmatched.add(u);
    return r.restored;
  }

  summary() {
    return {
      replacedCount: this.replacedCount,
      cellCount: this.cellCount,
      generalized: [...this.generalized].map(([from, to]) => ({ from, to })),
      unmatched: [...this.unmatched],
    };
  }
}

export function restoreSpreadsheet(source: SpreadsheetSource, restoreMap: Record<string, string>, generalizedMap: Record<string, string> = {}): SpreadsheetRestore {
  const tally = new Tally(restoreMap, generalizedMap);
  const fileName = restoredFileName(source.fileName);
  if (source.kind === 'csv') {
    const restored = restoreCsv(source.text, (v) => {
      const r = tally.restore(v);
      if (r !== v) tally.cellCount++;
      return r;
    });
    // 加工後の保存と同じく、Excel で開いても文字化けしないよう BOM 付き UTF-8・CRLF で書く
    return { ...tally.summary(), bytes: strToU8(`\uFEFF${restored.replace(/\n/g, '\r\n')}`), fileName, mimeType: 'text/csv', notes: [] };
  }
  const { bytes, notes } = restoreXlsx(source, tally);
  const isXlsm = source.fileName.toLowerCase().endsWith('.xlsm');
  return { ...tally.summary(), bytes, fileName, mimeType: isXlsm ? XLSM_MIME : XLSX_MIME, notes };
}

// ---- CSV ----

/** 区切り・改行・引用はそのまま残し、各欄の値だけを置き換える。戻した値に区切りなどが入れば " で囲む */
export function restoreCsv(text: string, restore: (value: string) => string): string {
  let out = '';
  let i = 0;
  while (i <= text.length) {
    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i++];
      }
      // 閉じ引用符のあとに区切りまで続く文字（壊れた CSV）は値に含める
      while (i < text.length && text[i] !== ',' && text[i] !== '\n') value += text[i++];
    } else {
      while (i < text.length && text[i] !== ',' && text[i] !== '\n') value += text[i++];
    }
    const restored = value === '' ? value : restore(value);
    out += quoted || /[",\n]/.test(restored) ? `"${restored.replace(/"/g, '""')}"` : restored;
    if (i >= text.length) break;
    out += text[i++];
  }
  return out;
}

// ---- xlsx ----

function restoreXlsx(source: Extract<SpreadsheetSource, { kind: 'xlsx' }>, tally: Tally): { bytes: Uint8Array; notes: string[] } {
  const entries = unzipXlsx(source.bytes, false);
  const files = new Map<string, string>();
  const text = (path: string) => {
    if (!files.has(path)) {
      const raw = entries[path];
      if (!raw) return null;
      files.set(path, new TextDecoder().decode(raw));
    }
    return files.get(path) ?? null;
  };
  const notes = new Set<string>();
  let formulaChanged = false;

  // 1. 文字のセルの新しい値。数値・日付・真偽値は戻す語を含まないので触らない
  const cellValues = source.sheets.map((sheet) => {
    const xml = text(sheet.path) ?? '';
    const values = new Map<number, string>();
    sheet.cells.forEach((cell, j) => {
      const original = xml.slice(cell.xmlStart, cell.xmlEnd);
      const type = /^<[^>]*?\st="([^"]*)"/.exec(original)?.[1];
      if (type !== 's' && type !== 'inlineStr' && type !== 'str') return;
      // 数式は残し、開いたときに計算し直してもらう（戻した値を参照する数式も原文で計算される）
      if (/<(?:[\w.-]+:)?f[\s>/]/.test(original)) {
        formulaChanged ||= tally.peek(cell.value) !== cell.value;
        return;
      }
      const value = tally.restore(cell.value);
      if (value === cell.value) return;
      values.set(j, value);
      tally.cellCount++;
    });
    return values;
  });
  const newNames = source.sheets.map((s) => tally.restore(s.name));

  // 2. テーブルの見出し → 3. セル（元の XML 上の位置を使うので、シート名の変更より先に行う）
  source.sheets.forEach((sheet, i) => syncTables(sheet, cellValues[i] ?? new Map(), text, files, new Set()));
  source.sheets.forEach((sheet, i) => {
    const values = cellValues[i];
    const xml = text(sheet.path);
    if (!values?.size || xml === null) return;
    let out = xml;
    [...values.entries()]
      .sort((a, b) => (sheet.cells[b[0]]?.xmlStart ?? 0) - (sheet.cells[a[0]]?.xmlStart ?? 0))
      .forEach(([j, value]) => {
        const cell = sheet.cells[j];
        if (cell) out = out.slice(0, cell.xmlStart) + writeCell(xml.slice(cell.xmlStart, cell.xmlEnd), value) + out.slice(cell.xmlEnd);
      });
    files.set(sheet.path, out);
  });

  // 4. シート名と、数式・名前定義の中の参照
  const renamed = new Set<string>();
  renameSheets(source.sheets, newNames, text, files, renamed);
  if (renamed.size) notes.add('シート名を元の語に戻し、数式の中の参照も合わせて書き換えました。');

  // 5. 数式は開いたときに計算し直す
  const hasFormula = source.sheets.some((s) => /<(?:[\w.-]+:)?f[\s>/]/.test(text(s.path) ?? ''));
  const anyChanged = formulaChanged || cellValues.some((v) => v.size > 0) || renamed.size > 0;
  if (hasFormula && anyChanged) {
    const wb = text('xl/workbook.xml');
    if (wb !== null) files.set('xl/workbook.xml', recalcOnLoad(wb));
    notes.add('数式は Excel で開いたときに計算し直されます。数式の中に直接書かれたラベルは戻していません。');
  }
  const names = Object.keys(entries);
  const untouched = [
    names.some((n) => /^xl\/(comments|threadedComments\/)/.test(n)) && 'コメント・メモ',
    names.some((n) => /^xl\/(charts|drawings)\//.test(n)) && 'グラフ・図形',
    names.some((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n) && /<(?:[\w.-]+:)?headerFooter\b/.test(text(n) ?? '')) && 'ヘッダー・フッター',
  ].filter(Boolean);
  if (untouched.length) notes.add(`${untouched.join('・')}の中の文字は戻していません。`);

  const out: Record<string, Uint8Array> = {};
  for (const path of names) {
    const changed = files.get(path);
    out[path] = changed !== undefined ? strToU8(changed) : (entries[path] ?? new Uint8Array());
  }
  return { bytes: zipSync(out), notes: [...notes] };
}

/** workbook.xml の calcPr に fullCalcOnLoad を付ける。なければ、スキーマの順序どおり definedNames などの後ろに入れる */
export function recalcOnLoad(wb: string): string {
  const calcPr = /<((?:[\w.-]+:)?)calcPr\b([^>]*?)(\/?)>/.exec(wb);
  if (calcPr) {
    const attrs = (calcPr[2] ?? '').replace(/\sfullCalcOnLoad="[^"]*"/, '');
    return wb.slice(0, calcPr.index) + `<${calcPr[1]}calcPr${attrs} fullCalcOnLoad="1"${calcPr[3]}>` + wb.slice(calcPr.index + calcPr[0].length);
  }
  const prefix = /<((?:[\w.-]+:)?)workbook\b/.exec(wb)?.[1] ?? '';
  let at = -1;
  for (const m of wb.matchAll(/<\/(?:[\w.-]+:)?(?:sheets|functionGroups|externalReferences|definedNames)>|<(?:[\w.-]+:)?(?:sheets|functionGroups|externalReferences|definedNames)\b[^>]*\/>/g)) {
    at = m.index + m[0].length;
  }
  if (at < 0) return wb;
  return `${wb.slice(0, at)}<${prefix}calcPr fullCalcOnLoad="1"/>${wb.slice(at)}`;
}
