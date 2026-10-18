import { unzipSync, type UnzipFileInfo } from 'fflate';

// Excel（.xlsx / .xlsm）と CSV を端末内で読み、セルの文字を解析用の文章にする（Issue #10）。
// 取り込むのはセルの値だけ。画像・コメント・埋め込みなどは取り込まず、notes で利用者に伝える。
// 加工後に同じ形式で保存できるよう、各セルが文章のどこに入ったかを source に残す（spreadsheet-export.ts）。

/** 文章上の位置 [textStart, textEnd) と、シート XML 上の要素の位置 [xmlStart, xmlEnd) */
export type CellLoc = { col: number; row: number; xmlStart: number; xmlEnd: number; textStart: number; textEnd: number; quoted: boolean; value: string };
export type SheetLoc = { path: string; relId: string; name: string; nameStart: number; nameEnd: number; cells: CellLoc[] };

/** 読み込んだ元ファイル。原文と同じくメモリにだけ置く */
export type SpreadsheetSource =
  | { kind: 'xlsx'; fileName: string; bytes: Uint8Array; text: string; sheets: SheetLoc[] }
  | { kind: 'csv'; fileName: string; text: string };

export type SpreadsheetImport = {
  text: string;
  /** 取り込まなかったもの・注意点。画面にそのまま出す */
  notes: string[];
  source: SpreadsheetSource;
};

export class SpreadsheetError extends Error {}

/** 圧縮前のファイルの上限。これより大きいものは開かない */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 展開後のファイル1つあたりの上限（ZIP 爆弾よけ） */
export const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm', '.csv'];

export async function readSpreadsheetFile(file: File): Promise<SpreadsheetImport> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xls')) throw new SpreadsheetError('古い形式（.xls）は読めません。Excel で .xlsx として保存し直してください。');
  if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) throw new SpreadsheetError('読める形式は .xlsx・.xlsm・.csv です。');
  if (file.size > MAX_FILE_BYTES) throw new SpreadsheetError(`ファイルが大きすぎます（上限 ${MAX_FILE_BYTES / 1024 / 1024}MB）。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith('.csv')) {
    const text = decodeCsv(bytes);
    return { text, notes: [], source: { kind: 'csv', fileName: file.name, text } };
  }
  return parseXlsx(bytes, file.name);
}

/** CSV は区切りをそのまま残す。UTF-8 として読めなければ Shift_JIS（日本語版 Excel の既定）として読む */
export function decodeCsv(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('shift_jis').decode(bytes);
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

// ---- xlsx ----

export function unzipXlsx(bytes: Uint8Array, onlyXml: boolean, names: string[] = []): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, {
      filter: (f: UnzipFileInfo) => {
        names.push(f.name);
        if (onlyXml && !f.name.endsWith('.xml') && !f.name.endsWith('.rels')) return false;
        if (f.originalSize > MAX_ENTRY_BYTES) throw new SpreadsheetError('ファイルの中身が大きすぎて読めません。');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof SpreadsheetError) throw e;
    throw new SpreadsheetError('Excel ファイルとして読めませんでした。パスワード付きのファイルは保護を外してから読み込んでください。');
  }
}

export function parseXlsx(bytes: Uint8Array, fileName = 'book.xlsx'): SpreadsheetImport {
  const names: string[] = [];
  const entries = unzipXlsx(bytes, true, names);
  const read = (path: string) => (entries[path] ? new TextDecoder().decode(entries[path]) : null);

  const workbookXml = read('xl/workbook.xml');
  if (!workbookXml) throw new SpreadsheetError('Excel ファイルとして読めませんでした。');
  const workbook = parseXml(workbookXml);
  const date1904 = find(workbook, 'workbookPr')?.attrs.date1904;
  const is1904 = date1904 === '1' || date1904 === 'true';
  const rels = parseRels(read('xl/_rels/workbook.xml.rels'), 'xl/');
  const shared = parseSharedStrings(read('xl/sharedStrings.xml'));
  const dateStyles = parseDateStyles(read('xl/styles.xml'));

  const notes: string[] = [];
  const sheets: SheetLoc[] = [];
  const skippedSheets: string[] = [];
  let hasFormula = false;
  let text = '';
  for (const sheet of findAll(workbook, 'sheet')) {
    const sheetName = sheet.attrs.name ?? '';
    const relId = sheet.attrs['r:id'] ?? sheet.attrs.id ?? '';
    const target = rels.get(relId)?.path;
    const xml = target ? read(target) : null;
    if (!target || !xml || !target.includes('worksheets/')) {
      skippedSheets.push(sheetName);
      continue;
    }
    const hidden = sheet.attrs.state === 'hidden' || sheet.attrs.state === 'veryHidden';
    if (text) text += '\n\n';
    text += '【シート: ';
    const nameStart = text.length;
    text += sheetName;
    const nameEnd = text.length;
    text += `${hidden ? '（非表示）' : ''}】`;

    const cells: CellLoc[] = [];
    let lastRow = -1;
    let lastCol = 0;
    for (const cell of scanCells(xml, shared, dateStyles, is1904)) {
      if (cell.value === '') continue;
      if (cell.row !== lastRow) {
        text += '\n' + '\t'.repeat(cell.col);
        lastRow = cell.row;
      } else {
        text += '\t'.repeat(Math.max(cell.col - lastCol, 1));
      }
      lastCol = cell.col;
      // 区切り文字・改行・引用符を含むセルは Excel の貼付けと同じく " で囲む
      const quoted = /[\t\n"]/.test(cell.value);
      if (quoted) text += '"';
      const textStart = text.length;
      text += quoted ? cell.value.replace(/"/g, '""') : cell.value;
      const textEnd = text.length;
      if (quoted) text += '"';
      cells.push({ ...cell, textStart, textEnd, quoted });
    }
    hasFormula ||= /<(\w+:)?f[\s>/]/.test(xml);
    sheets.push({ path: target, relId, name: sheetName, nameStart, nameEnd, cells });
    if (hidden) notes.push(`非表示のシート「${sheetName}」も取り込みました。`);
  }
  if (skippedSheets.length) notes.push(`グラフシートなど、セルのないシート（${skippedSheets.map((s) => `「${s}」`).join('')}）は取り込んでいません。`);

  const has = (re: RegExp) => names.some((n) => re.test(n));
  const omitted = [
    has(/^xl\/media\//) && '画像',
    has(/^xl\/(comments|threadedComments\/)/) && 'コメント・メモ',
    has(/^xl\/charts\//) && 'グラフ',
    has(/^xl\/(embeddings|activeX)\//) && '埋め込みファイル',
    has(/^xl\/drawings\//) && !has(/^xl\/media\//) && '図形・テキストボックス',
  ].filter(Boolean);
  if (omitted.length) notes.push(`${omitted.join('・')}は取り込んでいません。中に個人情報があっても検査されないため、元のファイルを AI に渡さないでください（加工後のファイルからは取り除きます）。`);
  if (has(/^xl\/vbaProject\.bin$/)) notes.push('マクロは取り込んでいません（実行もしていません）。');
  if (hasFormula) notes.push('数式は計算結果だけを取り込んでいます。');

  return { text, notes, source: { kind: 'xlsx', fileName, bytes, text, sheets } };
}

/** 行・セル要素。セルの中に別の行やセルは入らないので、要素の位置を正規表現で取れる */
export const ROW_OR_CELL = /<(?:[\w.-]+:)?row\b[^>]*?\/>|<(?:[\w.-]+:)?row\b[^>]*>|<\/(?:[\w.-]+:)?row>|<(?:[\w.-]+:)?c\b[^>]*?\/>|<(?:[\w.-]+:)?c\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?c>/g;

function* scanCells(xml: string, shared: string[], dateStyles: Set<number>, is1904: boolean) {
  let row = -1;
  let next = 0;
  for (const m of xml.matchAll(ROW_OR_CELL)) {
    if (m[0].startsWith('</')) continue;
    const node = parseXml(m[0]).children[0];
    if (!node) continue;
    if (node.name === 'row') {
      row = node.attrs.r ? Number(node.attrs.r) - 1 : row + 1;
      next = 0;
      continue;
    }
    const col = node.attrs.r ? columnIndex(node.attrs.r) : next;
    next = col + 1;
    const value = cellValue(node, shared, dateStyles, is1904).replace(/\r\n?/g, '\n');
    yield { col, row: Math.max(row, 0), xmlStart: m.index, xmlEnd: m.index + m[0].length, value };
  }
}

function cellValue(c: XmlNode, shared: string[], dateStyles: Set<number>, is1904: boolean): string {
  const v = find(c, 'v');
  const raw = v ? textOf(v) : '';
  switch (c.attrs.t) {
    case 's':
      return shared[Number(raw)] ?? '';
    case 'inlineStr': {
      const is = find(c, 'is');
      return is ? richText(is) : '';
    }
    case 'b':
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    case 'str':
    case 'e':
      return raw;
    default: {
      if (raw === '') return '';
      const n = Number(raw);
      if (Number.isFinite(n) && dateStyles.has(Number(c.attrs.s ?? 0))) return formatSerialDate(n, is1904);
      return raw;
    }
  }
}

/** "AB12" → 27 */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return Math.max(n - 1, 0);
}

/** Excel の日付シリアル値 → "2024/01/31" または "2024/01/31 09:30" */
export function formatSerialDate(serial: number, is1904 = false): string {
  // 1900年方式は 1900/2/29（実在しない日）を数えるため、基準日を 1899/12/30 にずらして合わせる
  const days = Math.floor(serial) + (is1904 ? 1462 : 0) - 25569; // 1970/1/1 からの日数
  const { y, m, d } = civilFromDays(days);
  const date = `${y}/${pad(m)}/${pad(d)}`;
  const minutes = Math.round((serial - Math.floor(serial)) * 24 * 60);
  if (minutes === 0) return date;
  if (minutes === 24 * 60) return formatSerialDate(Math.floor(serial) + 1, is1904);
  return `${date} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

// 1970/1/1 からの日数 → 年月日（Howard Hinnant の civil_from_days）
function civilFromDays(z: number) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return findAll(parseXml(xml), 'si').map(richText);
}

/** <t> と <r><t> をつなぐ。ふりがな（<rPh>）は除く */
function richText(node: XmlNode): string {
  let out = '';
  for (const child of node.children) {
    if (child.name === 't') out += textOf(child);
    else if (child.name === 'r') out += richText(child);
  }
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** 日付の表示形式を持つセルスタイル（cellXfs の番号）を返す */
function parseDateStyles(xml: string | null): Set<number> {
  const result = new Set<number>();
  if (!xml) return result;
  const root = parseXml(xml);
  const custom = new Map<number, string>();
  for (const f of findAll(root, 'numFmt')) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? '');
  const cellXfs = find(root, 'cellXfs');
  cellXfs?.children
    .filter((x) => x.name === 'xf')
    .forEach((xf, i) => {
      const id = Number(xf.attrs.numFmtId ?? 0);
      const code = custom.get(id);
      if (code !== undefined ? isDateFormat(code) : BUILTIN_DATE_FORMATS.has(id)) result.add(i);
    });
  return result;
}

function isDateFormat(code: string): boolean {
  // 引用文字・色や条件の [...]・エスケープを除いてから、日付時刻の記号を探す
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(stripped.replace(/General/gi, ''));
}

export type Rel = { path: string; type: string; external: boolean };

/** .rels を読む。base は参照元の部品があるフォルダ（例: "xl/worksheets/"） */
export function parseRels(xml: string | null, base: string): Map<string, Rel> {
  const map = new Map<string, Rel>();
  if (!xml) return map;
  for (const r of findAll(parseXml(xml), 'Relationship')) {
    const external = r.attrs.TargetMode === 'External';
    const target = r.attrs.Target ?? '';
    map.set(r.attrs.Id ?? '', { path: external ? target : resolvePath(base, target), type: r.attrs.Type ?? '', external });
  }
  return map;
}

export function resolvePath(base: string, target: string): string {
  const out: string[] = [];
  for (const p of (target.startsWith('/') ? target.slice(1) : base + target).split('/')) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return out.join('/');
}

// ---- 最小の XML 読み取り（xlsx の要素だけを対象。名前空間の接頭辞は外す） ----

export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(xml)); ) {
    const top = stack.at(-1) ?? root;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
    else if (m[3] === undefined) continue;
    else if (m[2] === '/') {
      if (stack.length > 1) stack.pop();
    } else {
      const node: XmlNode = { name: localName(m[3]), attrs: parseAttrs(m[4] ?? ''), children: [], text: '' };
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
    }
  }
  return root;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of s.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = m[1] ?? '';
    const key = name.startsWith('r:') ? name : localName(name);
    attrs[key] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

const localName = (n: string) => n.slice(n.indexOf(':') + 1);

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()] ?? '';
  });
}

/** _x000D_ のような Excel 独自の文字エスケープも戻す */
const textOf = (n: XmlNode) => n.text.replace(/_x([0-9a-fA-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

export function find(node: XmlNode, name: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}
