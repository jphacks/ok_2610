import { strToU8, zipSync } from 'fflate';
import type { OutputSegment } from '../core/model/types';
import { parseRels, ROW_OR_CELL, unzipXlsx, type SheetLoc, type SpreadsheetSource } from './spreadsheet';

// 加工後の文章を、読み込んだ元ファイルと同じ形式で書き出す（Issue #10）。
// xlsx は元の部品をそのまま使い、加工で値が変わったセルとシート名だけを書き換える。書式・列幅・結合などは残る。
// 検査していない部品（画像・コメント・グラフ・ファイル情報など）は、加工後のファイルに持ち込まないよう取り除く。

export type SpreadsheetExport = { bytes: Uint8Array; fileName: string; mimeType: string; notes: string[] };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSM_MIME = 'application/vnd.ms-excel.sheet.macroEnabled.12';

export function maskedFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)}_加工済み${fileName.slice(dot)}` : `${fileName}_加工済み`;
}

/** segments は解析結果の OutputSegment。原文を先頭から順に覆っている */
export function exportSpreadsheet(source: SpreadsheetSource, segments: OutputSegment[]): SpreadsheetExport {
  const fileName = maskedFileName(source.fileName);
  if (source.kind === 'csv') {
    // Excel で開いたときに文字化けしないよう、BOM 付き UTF-8・CRLF で書く
    const masked = segments.map((s) => s.text).join('');
    return { bytes: strToU8(`\uFEFF${masked.replace(/\n/g, '\r\n')}`), fileName, mimeType: 'text/csv', notes: [] };
  }
  const isXlsm = source.fileName.toLowerCase().endsWith('.xlsm');
  return { ...exportXlsx(source, segments), fileName, mimeType: isXlsm ? XLSM_MIME : XLSX_MIME };
}

// ---- 加工後の文章 → セルごとの新しい値 ----

type Range = { start: number; end: number };

/** 原文上の各範囲について、加工後の文字列を求める。範囲をまたぐ置換は、置換が始まる範囲にまとめて入れる */
export function mapRanges(segments: OutputSegment[], ranges: Range[]): string[] {
  const outs = ranges.map(() => '');
  let pos = 0;
  let k = 0;
  for (const seg of segments) {
    const len = seg.kind === 'changed' ? seg.original.length : seg.text.length;
    const start = pos;
    const end = pos + len;
    pos = end;
    while (k < ranges.length && (ranges[k]?.end ?? 0) <= start) k++;
    for (let j = k; j < ranges.length; j++) {
      const r = ranges[j];
      if (!r || r.start >= end) break;
      if (seg.kind === 'changed') {
        // 区切りや見出しの中で始まる置換は、次の範囲に重なるときだけその範囲に入れる
        outs[j] += seg.text;
        break;
      }
      outs[j] += seg.text.slice(Math.max(r.start, start) - start, Math.min(r.end, end) - start);
    }
  }
  return outs;
}

// ---- xlsx ----

/** 加工後のファイルに持ち込まない部品。検査していない文字や作成者などの情報を含みうる */
const STRIP =
  /^(docProps\/|customXml\/|xl\/(comments[^/]*\.xml$|threadedComments\/|persons\/|drawings\/|media\/|charts\/|chartsheets\/|dialogsheets\/|macrosheets\/|embeddings\/|activeX\/|ctrlProps\/|pivotCache\/|pivotTables\/|externalLinks\/|printerSettings\/|slicers\/|slicerCaches\/|timelines\/|timelineCaches\/|queryTables\/|richData\/|webextensions\/|model\/|customData\/|calcChain\.xml$|connections\.xml$|vbaProject\.bin$|vbaProjectSignature\.bin$|vbaData\.xml$))/;

const STRIP_LABELS: [RegExp, string][] = [
  [/^xl\/(media|drawings|richData)\//, '画像・図形'],
  [/^xl\/(comments|threadedComments\/|persons\/)/, 'コメント・メモ'],
  [/^xl\/(charts|chartsheets)\//, 'グラフ'],
  [/^xl\/(embeddings|activeX|ctrlProps)\//, '埋め込みファイル・コントロール'],
  [/^xl\/(pivotCache|pivotTables|slicers|slicerCaches|timelines|timelineCaches)\//, 'ピボットテーブル・スライサー'],
  [/^xl\/(externalLinks\/|connections\.xml|queryTables\/|model\/)/, '外部データへの接続'],
  [/^xl\/vba/, 'マクロ'],
  [/^docProps\//, '作成者などのファイル情報'],
];

function exportXlsx(source: Extract<SpreadsheetSource, { kind: 'xlsx' }>, segments: OutputSegment[]): { bytes: Uint8Array; notes: string[] } {
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

  // 1. セルとシート名の新しい値
  const ranges: (Range & { sheet: number; cell: number })[] = [];
  source.sheets.forEach((sheet, i) => {
    ranges.push({ start: sheet.nameStart, end: sheet.nameEnd, sheet: i, cell: -1 });
    sheet.cells.forEach((c, j) => ranges.push({ start: c.textStart, end: c.textEnd, sheet: i, cell: j }));
  });
  const outs = mapRanges(segments, ranges);
  const newNames = source.sheets.map((s) => s.name);
  const cellValues = source.sheets.map(() => new Map<number, string>());
  ranges.forEach((r, i) => {
    const sheet = source.sheets[r.sheet];
    if (!sheet) return;
    const out = outs[i] ?? '';
    if (r.cell < 0) {
      if (out !== sheet.name) newNames[r.sheet] = out;
      return;
    }
    const cell = sheet.cells[r.cell];
    const value = cell?.quoted ? out.replace(/""/g, '"') : out;
    if (cell && value !== cell.value) cellValues[r.sheet]?.set(r.cell, value);
  });

  // 2. テーブルの見出しはセルと一致していないと Excel が修復を求めるので、合わせて書き換える
  source.sheets.forEach((sheet, i) => syncTables(sheet, cellValues[i] ?? new Map(), text, files, notes));

  // 3. セルの書き換え（元の XML 上の位置を使うので、ほかの書き換えより先に行う）
  source.sheets.forEach((sheet, i) => {
    const values = cellValues[i];
    const xml = text(sheet.path);
    if (!values?.size || xml === null) return;
    let out = xml;
    [...values.entries()]
      .sort((a, b) => (sheet.cells[b[0]]?.xmlStart ?? 0) - (sheet.cells[a[0]]?.xmlStart ?? 0))
      .forEach(([j, value]) => {
        const cell = sheet.cells[j];
        if (!cell) return;
        const original = xml.slice(cell.xmlStart, cell.xmlEnd);
        if (/<(?:[\w.-]+:)?f[\s>/]/.test(original)) notes.add('加工した値を含む数式のセルは、計算結果の値に置き換えました。');
        out = out.slice(0, cell.xmlStart) + writeCell(original, value) + out.slice(cell.xmlEnd);
      });
    files.set(sheet.path, out);
  });

  // 4. シート名の変更と、数式・リンク・名前定義の中の参照
  renameSheets(source.sheets, newNames, text, files, notes);

  // 5. 検査していない部品を取り除き、参照を整える
  const removed = Object.keys(entries).filter((p) => STRIP.test(p));
  for (const p of removed) {
    const label = STRIP_LABELS.find(([re]) => re.test(p))?.[1];
    if (label) notes.add(`${label}は加工後のファイルから取り除きました。`);
  }
  const present = new Set(Object.keys(entries).filter((p) => !STRIP.test(p)));
  removeDanglingRels(present, text, files, notes);
  for (const path of [...present]) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) continue;
    let xml = text(path);
    if (xml === null) continue;
    // ヘッダー・フッターは検査していない
    const withoutHF = xml.replace(/<((?:[\w.-]+:)?headerFooter)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g, '');
    if (withoutHF !== xml) notes.add('ヘッダー・フッターは加工後のファイルから取り除きました。');
    xml = withoutHF;
    // 画像を入れたセルの参照（取り除いた richData を指す）
    if (removed.some((p) => p.startsWith('xl/richData/'))) xml = xml.replace(/(<(?:[\w.-]+:)?c\b[^>]*?)\svm="[^"]*"/g, '$1');
    files.set(path, xml);
  }
  const wb = text('xl/workbook.xml');
  if (wb !== null) files.set('xl/workbook.xml', wb.replace(/<(?:[\w.-]+:)?fileSharing\b[^>]*\/>/g, ''));

  // 6. どのセルからも参照されなくなった共有文字列は空にする（元の値が残らないように）
  blankUnusedSharedStrings(present, text, files);

  // 7. [Content_Types].xml から取り除いた部品を外す
  const types = text('[Content_Types].xml');
  if (types !== null) {
    files.set(
      '[Content_Types].xml',
      types.replace(/<Override\b[^>]*PartName="\/([^"]+)"[^>]*\/>/g, (m, part: string) => (present.has(part) || present.has(safeDecode(part)) ? m : '')),
    );
  }

  const out: Record<string, Uint8Array> = {};
  for (const path of Object.keys(entries)) {
    if (!present.has(path)) continue;
    const changed = files.get(path);
    out[path] = changed !== undefined ? strToU8(changed) : (entries[path] ?? new Uint8Array());
  }
  return { bytes: zipSync(out), notes: [...notes] };
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

function writeCell(original: string, value: string): string {
  const open = /^<((?:[\w.-]+:)?)c\b([^>]*?)\/?>/.exec(original);
  const prefix = open?.[1] ?? '';
  const attrs = (open?.[2] ?? '').replace(/\s(t|cm|vm|ph)="[^"]*"/g, '');
  if (value === '') return `<${prefix}c${attrs}/>`;
  return `<${prefix}c${attrs} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${escapeXml(value)}</${prefix}t></${prefix}is></${prefix}c>`;
}

export function escapeXml(s: string): string {
  return s
    // XML に書けない制御文字は落とす
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/_x([0-9a-fA-F]{4})_/g, '_x005F_x$1_')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const relsPathOf = (part: string) => {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
};
const dirOf = (part: string) => part.slice(0, part.lastIndexOf('/') + 1);

type Text = (path: string) => string | null;

function syncTables(sheet: SheetLoc, values: Map<number, string>, text: Text, files: Map<string, string>, notes: Set<string>) {
  if (!values.size) return;
  const byPos = new Map(sheet.cells.map((c, j) => [`${c.col},${c.row}`, j]));
  for (const rel of parseRels(text(relsPathOf(sheet.path)), dirOf(sheet.path)).values()) {
    if (!rel.type.endsWith('/table')) continue;
    const xml = text(rel.path);
    if (xml === null) continue;
    const table = /<(?:[\w.-]+:)?table\b[^>]*>/.exec(xml)?.[0] ?? '';
    const ref = /\sref="([A-Z]+)(\d+)/.exec(table);
    if (!ref || /\sheaderRowCount="0"/.test(table)) continue;
    const col0 = columnOf(ref[1] ?? 'A');
    const row0 = Number(ref[2]) - 1;
    let i = 0;
    const updated = xml.replace(/(<(?:[\w.-]+:)?tableColumn\b[^>]*?\sname=")([^"]*)(")/g, (m, a: string, _name: string, b: string) => {
      const j = byPos.get(`${col0 + i},${row0}`);
      const n = i++;
      if (j === undefined || !values.has(j)) return m;
      let value = values.get(j) ?? '';
      if (value === '') {
        // テーブルの見出しは空にできない
        value = `列${n + 1}`;
        values.set(j, value);
      }
      return `${a}${escapeXml(value)}${b}`;
    });
    if (updated !== xml) {
      files.set(rel.path, updated);
      notes.add('テーブルの見出しを加工したため、テーブルの列名も合わせて変えました。');
    }
  }
}

function columnOf(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function renameSheets(sheets: SheetLoc[], newNames: string[], text: Text, files: Map<string, string>, notes: Set<string>) {
  const used = new Set(sheets.map((s, i) => (newNames[i] === s.name ? s.name.toLowerCase() : '')));
  const renames: [string, string][] = [];
  sheets.forEach((s, i) => {
    if (newNames[i] === s.name) return;
    const name = safeSheetName(newNames[i] ?? '', used, i);
    renames.push([s.name, name]);
    newNames[i] = name;
  });
  if (!renames.length) return;
  notes.add('シート名を加工したため、シート名と数式の中の参照を書き換えました。');

  const wb = text('xl/workbook.xml');
  if (wb !== null) {
    let out = wb;
    sheets.forEach((s, i) => {
      if (newNames[i] === s.name) return;
      const relId = s.relId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const name = escapeXml(newNames[i] ?? '');
      out = out.replace(new RegExp(`(<(?:[\\w.-]+:)?sheet\\b[^>]*?\\sname=")[^"]*("[^>]*?\\bid="${relId}")`), (_, a: string, b: string) => a + name + b);
      out = out.replace(new RegExp(`(<(?:[\\w.-]+:)?sheet\\b[^>]*?\\bid="${relId}"[^>]*?\\sname=")[^"]*(")`), (_, a: string, b: string) => a + name + b);
    });
    out = out.replace(/(<(?:[\w.-]+:)?definedName\b[^>]*>)([\s\S]*?)(<\/)/g, (_, a: string, body: string, b: string) => a + renameRefs(body, renames) + b);
    files.set('xl/workbook.xml', out);
  }
  for (const s of sheets) {
    const xml = text(s.path);
    if (xml === null) continue;
    files.set(
      s.path,
      xml
        .replace(/(<(?:[\w.-]+:)?f\b[^>]*>)([\s\S]*?)(<\/)/g, (_, a: string, body: string, b: string) => a + renameRefs(body, renames) + b)
        .replace(/(\slocation=")([^"]*)(")/g, (_, a: string, body: string, b: string) => a + renameRefs(body, renames) + b),
    );
  }
}

/** 数式中の Sheet!A1 / 'Sheet name'!A1 を新しい名前に。XML 上の文字列（実体参照のまま）を扱う */
function renameRefs(formula: string, renames: [string, string][]): string {
  let out = formula;
  for (const [from, to] of renames) {
    const quotedTo = `'${escapeXml(to).replace(/'/g, "''")}'!`;
    const quotedFrom = `'${escapeXml(from).replace(/'/g, "''")}'!`;
    out = out.split(quotedFrom).join(quotedTo);
    const bare = escapeXml(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_.'\\]])${bare}!`, 'gu'), quotedTo);
  }
  return out;
}

/** Excel のシート名の制約（31文字・[]:*?/\ を使えない・重複しない）に合わせる */
export function safeSheetName(name: string, used: Set<string>, index: number): string {
  let n = name
    .replace(/\[/g, '（')
    .replace(/\]/g, '）')
    .replace(/[:\\/?*]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31);
  if (!n) n = `Sheet${index + 1}`;
  const base = n;
  for (let k = 2; used.has(n.toLowerCase()); k++) n = `${base.slice(0, 31 - String(k).length - 2)}(${k})`;
  used.add(n.toLowerCase());
  return n;
}

/** 取り除いた部品・外部リンクへの参照を .rels と参照元の XML から消す */
function removeDanglingRels(present: Set<string>, text: Text, files: Map<string, string>, notes: Set<string>) {
  for (const relsPath of [...present]) {
    if (!relsPath.endsWith('.rels')) continue;
    const owner = relsPath.replace(/_rels\/([^/]*)\.rels$/, '$1');
    const xml = text(relsPath);
    if (xml === null) continue;
    const rels = parseRels(xml, dirOf(owner));
    const drop = new Set([...rels.entries()].filter(([, r]) => r.external || !present.has(r.path)).map(([id]) => id));
    if (!drop.size) continue;
    if ([...rels.entries()].some(([id, r]) => drop.has(id) && r.external)) notes.add('外部へのリンク（ハイパーリンクなど）は加工後のファイルから取り除きました。');
    files.set(
      relsPath,
      xml.replace(/<(?:[\w.-]+:)?Relationship\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?Relationship>)/g, (m) => {
        const id = /\sId="([^"]*)"/.exec(m)?.[1];
        return id !== undefined && drop.has(id) ? '' : m;
      }),
    );
    const ownerXml = owner === '' ? null : text(owner);
    if (ownerXml === null || !present.has(owner)) continue;
    files.set(owner, removeRefsTo(ownerXml, drop, owner === 'xl/workbook.xml'));
  }
}

const CONTAINERS = 'hyperlinks|oleObjects|controls|pivotCaches|externalReferences|slicerList|slicerCaches|timelineRefs|timelineCacheRefs|ext|extLst';

function removeRefsTo(xml: string, ids: Set<string>, isWorkbook: boolean): string {
  const hit = (attrs: string) => [...attrs.matchAll(/\s[\w.-]+:id="([^"]*)"/g)].some((m) => ids.has(m[1] ?? ''));
  // 消えるシートの番号（名前定義の localSheetId と表示中のシートを合わせるため）
  const removedSheets: number[] = [];
  if (isWorkbook) [...xml.matchAll(/<(?:[\w.-]+:)?sheet\b([^>]*)\/>/g)].forEach((m, i) => hit(m[1] ?? '') && removedSheets.push(i));

  // r:id で消した部品を指す要素を取り除く。中身を持つ要素は、同じ名前の閉じタグまで消す
  let out = '';
  let from = 0;
  const tag = /<((?:[\w.-]+:)?[\w.-]+)\b([^>]*?)(\/?)>/g;
  for (let m; (m = tag.exec(xml)); ) {
    if (!hit(m[2] ?? '')) continue;
    out += xml.slice(from, m.index);
    if (m[3] === '/') {
      from = tag.lastIndex;
      continue;
    }
    const close = `</${m[1]}>`;
    const end = xml.indexOf(close, tag.lastIndex);
    from = end < 0 ? tag.lastIndex : end + close.length;
    tag.lastIndex = from;
  }
  out += xml.slice(from);
  const empty = new RegExp(`<((?:[\\w.-]+:)?(?:${CONTAINERS}))\\b[^>]*>\\s*<\\/\\1>`, 'g');
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(empty, '');
  }
  if (isWorkbook && removedSheets.length) {
    out = out
      .replace(/(<(?:[\w.-]+:)?definedName\b[^>]*?\slocalSheetId=")(\d+)("[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?definedName>)/g, (m, a: string, n: string, b: string) => {
        const k = Number(n);
        return removedSheets.includes(k) ? '' : `${a}${k - removedSheets.filter((r) => r < k).length}${b}`;
      })
      .replace(/\s(activeTab|firstSheet)="\d+"/g, '');
  }
  return out;
}

function blankUnusedSharedStrings(present: Set<string>, text: Text, files: Map<string, string>) {
  const sst = text('xl/sharedStrings.xml');
  if (sst === null) return;
  const used = new Set<number>();
  for (const path of present) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) continue;
    for (const m of (text(path) ?? '').matchAll(ROW_OR_CELL)) {
      const open = /^<[^>]*>/.exec(m[0])?.[0] ?? '';
      if (!/\st="s"/.test(open)) continue;
      const v = /<(?:[\w.-]+:)?v>\s*(\d+)\s*</.exec(m[0]);
      if (v) used.add(Number(v[1]));
    }
  }
  let i = 0;
  files.set(
    'xl/sharedStrings.xml',
    sst.replace(/<((?:[\w.-]+:)?)si\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?si>)/g, (m, p: string) => (used.has(i++) ? m : `<${p}si><${p}t/></${p}si>`)),
  );
}
