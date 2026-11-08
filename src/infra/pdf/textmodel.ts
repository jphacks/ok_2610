import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocument, type PDFPageLeaf } from 'pdf-lib';
import { loadFont, fontResource, type FontInfo } from './fonts';
import { parseContent, type Op, type Token } from './lexer';
import { arrayNumbers, dictGet, getArray, getDict, getName, inherited, N, resolve, streamBytes } from './objects';

// ページの描画命令を順に実行し、文字1つずつが「どの命令の、どのバイトか」と「ページ上のどこか」を記録する（Issue #9）。
// 記録した文字から解析用の文章を組み立て、マスクと復元ではこの対応を使って命令を書き換える。

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function applyPoint(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

/** 書き換えの単位。ページの本文（複数のストリームは1つにまとめる）か、フォーム XObject */
export type Unit = {
  id: number;
  kind: 'page' | 'form';
  pageIndex: number;
  /** フォームのストリームの参照 */
  ref?: PDFRef;
  page?: PDFPageLeaf;
  resources: PDFDict | undefined;
  ops: Op[];
};

export type TextState = { font: FontInfo | null; fontName: string | null; size: number; tc: number; tw: number; th: number; tl: number; ts: number; tr: number };

export type GlyphRef = {
  unit: number;
  op: number;
  /** TJ の配列の何番目の要素か（Tj・'・" は 0） */
  part: number;
  start: number;
  end: number;
  code: number;
  unicode: string | null;
  /** 1/1000 単位の送り幅 */
  width: number;
  wordSpace: boolean;
  state: TextState;
  /** ページ上（ユーザー空間）の原点と、送り幅のベクトル */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** 文字の高さ（ユーザー空間） */
  h: number;
  /** 文字空間での送り幅（Tc・Tw・Tz 込み） */
  adv: number;
  page: number;
  vertical: boolean;
};

export type ImagePlacement = { page: number; ref: PDFRef; ctm: Matrix; unit: number; op: number };

export type ModelIssue = { page: number; kind: 'font' | 'inlineImage' | 'vertical' | 'gsFont'; message: string };

export type TextModel = {
  units: Unit[];
  glyphs: GlyphRef[];
  images: ImagePlacement[];
  issues: ModelIssue[];
  pageCount: number;
  /** ページごとの大きさ（MediaBox） */
  pageBoxes: [number, number, number, number][];
};

const MAX_DEPTH = 12;

export function buildTextModel(doc: PDFDocument, maxPages = Infinity): TextModel {
  const ctx = doc.context;
  const units: Unit[] = [];
  const glyphs: GlyphRef[] = [];
  const images: ImagePlacement[] = [];
  const issues: ModelIssue[] = [];
  const formUnits = new Map<PDFRef, Unit>();
  const pages = doc.getPages();
  const pageCount = Math.min(pages.length, maxPages);
  const pageBoxes: TextModel['pageBoxes'] = [];
  const issueKeys = new Set<string>();
  const issue = (i: ModelIssue) => {
    const key = `${i.page}|${i.kind}|${i.message}`;
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push(i);
    }
  };

  for (let p = 0; p < pageCount; p++) {
    const leaf = pages[p]!.node;
    const box = arrayNumbers(ctx, inherited(ctx, leaf, 'MediaBox') as PDFArray | undefined);
    pageBoxes.push([box[0] ?? 0, box[1] ?? 0, box[2] ?? 612, box[3] ?? 792]);
    const resources = inherited(ctx, leaf, 'Resources');
    const unit: Unit = { id: units.length, kind: 'page', pageIndex: p, page: leaf, resources: resources instanceof PDFDict ? resources : undefined, ops: parseContent(pageContentBytes(doc, leaf)) };
    units.push(unit);
    run(unit, IDENTITY, 0, true);
  }

  function run(unit: Unit, base: Matrix, depth: number, record: boolean) {
    const res = unit.resources;
    let gs = { ctm: base, text: { font: null, fontName: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0 } as TextState };
    const stack: (typeof gs)[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    const page = unit.pageIndex;
    const n = (t: Token | undefined) => (t?.t === 'num' ? t.v : 0);

    const nextLine = (tx: number, ty: number) => {
      tlm = mul([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm;
    };

    const show = (opIndex: number, part: number, bytes: Uint8Array) => {
      const st = gs.text;
      if (!st.font) {
        issue({ page, kind: 'font', message: 'フォントの指定がない文字があります' });
        return;
      }
      const font = st.font;
      if (!font.supported) issue({ page, kind: 'font', message: `読めないフォント（${font.baseFont || font.subtype}）の文字があります: ${font.reason ?? ''}` });
      if (font.vertical) issue({ page, kind: 'vertical', message: '縦書きの文字があります' });
      for (const g of font.decode(bytes)) {
        const m = mul(tm, gs.ctm);
        const trm = mul([st.size * st.th, 0, 0, st.size, 0, st.ts], m);
        const w = Number.isFinite(g.width) ? g.width : 0;
        let adv: number;
        if (font.vertical) {
          adv = -(st.size + st.tc + (g.wordSpace ? st.tw : 0));
        } else {
          adv = ((w / 1000) * st.size + st.tc + (g.wordSpace ? st.tw : 0)) * st.th;
        }
        const [dx, dy] = font.vertical ? [adv * m[2], adv * m[3]] : [adv * m[0], adv * m[1]];
        if (record) {
          glyphs.push({
            unit: unit.id, op: opIndex, part, start: g.start, end: g.end, code: g.code, unicode: g.unicode, width: g.width, wordSpace: g.wordSpace,
            state: { ...st }, x: trm[4], y: trm[5], dx, dy, h: Math.hypot(trm[2], trm[3]) || st.size, adv, page, vertical: font.vertical,
          });
        }
        tm = font.vertical ? mul([1, 0, 0, 1, 0, adv], tm) : mul([1, 0, 0, 1, adv, 0], tm);
      }
    };

    unit.ops.forEach((o, i) => {
      const a = o.args;
      switch (o.op) {
        case 'q': stack.push({ ctm: gs.ctm, text: { ...gs.text } }); break;
        case 'Q': gs = stack.pop() ?? gs; break;
        case 'cm': gs = { ...gs, ctm: mul([n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5])], gs.ctm) }; break;
        case 'BT': tm = IDENTITY; tlm = IDENTITY; break;
        case 'Tf': {
          const nameTok = a[0];
          const fontName = nameTok?.t === 'name' ? nameTok.v : null;
          const font = fontName ? loadFont(ctx, fontResource(ctx, res, fontName)) : null;
          gs.text = { ...gs.text, font, fontName, size: n(a[1]) };
          break;
        }
        case 'Tc': gs.text = { ...gs.text, tc: n(a[0]) }; break;
        case 'Tw': gs.text = { ...gs.text, tw: n(a[0]) }; break;
        case 'Tz': gs.text = { ...gs.text, th: n(a[0]) / 100 }; break;
        case 'TL': gs.text = { ...gs.text, tl: n(a[0]) }; break;
        case 'Ts': gs.text = { ...gs.text, ts: n(a[0]) }; break;
        case 'Tr': gs.text = { ...gs.text, tr: n(a[0]) }; break;
        case 'Td': nextLine(n(a[0]), n(a[1])); break;
        case 'TD': gs.text = { ...gs.text, tl: -n(a[1]) }; nextLine(n(a[0]), n(a[1])); break;
        case 'Tm': tm = tlm = [n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5])]; break;
        case 'T*': nextLine(0, -gs.text.tl); break;
        case 'Tj': if (a[0]?.t === 'str') show(i, 0, a[0].bytes); break;
        case "'": nextLine(0, -gs.text.tl); if (a[0]?.t === 'str') show(i, 0, a[0].bytes); break;
        case '"':
          gs.text = { ...gs.text, tw: n(a[0]), tc: n(a[1]) };
          nextLine(0, -gs.text.tl);
          if (a[2]?.t === 'str') show(i, 0, a[2].bytes);
          break;
        case 'TJ': {
          const arr = a[0];
          if (arr?.t !== 'arr') break;
          arr.items.forEach((item, k) => {
            if (item.t === 'str') show(i, k, item.bytes);
            else if (item.t === 'num') {
              const st = gs.text;
              const d = (-item.v / 1000) * st.size * st.th;
              tm = st.font?.vertical ? mul([1, 0, 0, 1, 0, -(item.v / 1000) * st.size], tm) : mul([1, 0, 0, 1, d, 0], tm);
            }
          });
          break;
        }
        case 'gs': {
          const nameTok = a[0];
          const egs = nameTok?.t === 'name' ? getDict(ctx, getDict(ctx, res, 'ExtGState'), nameTok.v) : undefined;
          if (egs && egs.get(N('Font'))) {
            const fontArr = getArray(ctx, egs, 'Font');
            const f = fontArr ? fontArr.get(0) : undefined;
            const size = fontArr ? resolve(ctx, fontArr.get(1)) : undefined;
            gs.text = { ...gs.text, font: loadFont(ctx, f instanceof PDFRef || f instanceof PDFDict ? f : undefined), fontName: null, size: size instanceof PDFNumber ? size.asNumber() : gs.text.size };
            issue({ page, kind: 'gsFont', message: '描画状態（ExtGState）でフォントを指定している文字があります' });
          }
          break;
        }
        case 'Do': {
          const nameTok = a[0];
          if (nameTok?.t !== 'name') break;
          const xobjects = getDict(ctx, res, 'XObject');
          const raw = xobjects?.get(N(nameTok.v));
          const ref = raw instanceof PDFRef ? raw : undefined;
          const obj = resolve(ctx, raw);
          if (!(obj instanceof PDFStream)) break;
          const subtype = getName(ctx, obj.dict, 'Subtype');
          if (subtype === 'Image') {
            if (ref) images.push({ page, ref, ctm: gs.ctm, unit: unit.id, op: i });
          } else if (subtype === 'Form' && ref && depth < MAX_DEPTH) {
            let form = formUnits.get(ref);
            const first = !form;
            if (!form) {
              const fres = dictGet(ctx, obj.dict, 'Resources');
              form = { id: units.length, kind: 'form', pageIndex: page, ref, resources: fres instanceof PDFDict ? fres : res, ops: parseContent(streamBytes(obj)) };
              units.push(form);
              formUnits.set(ref, form);
            }
            const fm = arrayNumbers(ctx, getArray(ctx, obj.dict, 'Matrix'));
            const matrix: Matrix = fm.length === 6 ? (fm as Matrix) : IDENTITY;
            run(form, mul(matrix, gs.ctm), depth + 1, record && first);
          }
          break;
        }
        case 'BI':
          issue({ page, kind: 'inlineImage', message: '本文に直接埋め込まれた小さな画像があり、その中の文字は検査していません' });
          break;
        default:
          break;
      }
    });
  }

  return { units, glyphs, images, issues, pageCount, pageBoxes };
}

/** ページの /Contents（1つでも配列でも）を1つのバイト列にする */
export function pageContentBytes(doc: PDFDocument, leaf: PDFPageLeaf): Uint8Array {
  const ctx = doc.context;
  const contents = dictGet(ctx, leaf, 'Contents');
  const streams: PDFStream[] = [];
  if (contents instanceof PDFStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = resolve(ctx, contents.get(i));
      if (s instanceof PDFStream) streams.push(s);
    }
  }
  const parts = streams.map((s) => streamBytes(s));
  const size = parts.reduce((k, b) => k + b.length + 1, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
    out[at++] = 0x0a;
  }
  return out;
}

// ---- 解析用の文章 ----

/** 文章の各文字が、どの文字（glyphs の番号）から来たか。区切りや見出しは -1 */
export type CharMap = Int32Array;

/** 和文（全角の記号・かな・漢字・全角英数）を含むか */
const isCjk = (s: string) => {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) return true;
  }
  return false;
};

/** 1ページ分の文字から本文を組み立てる。行の変わり目は改行、離れた語の間は空白にする */
export function pageText(glyphs: GlyphRef[], indices: number[]): { text: string; map: number[]; unknown: number } {
  let text = '';
  const map: number[] = [];
  let unknown = 0;
  let prev: GlyphRef | undefined;
  for (const gi of indices) {
    const g = glyphs[gi]!;
    if (g.unicode === null) {
      unknown++;
      continue;
    }
    if (!g.unicode) continue;
    if (prev && text) {
      const sep = separator(prev, g);
      if (sep && !text.endsWith(sep) && !(sep === ' ' && text.endsWith('\n'))) {
        text += sep;
        map.push(-1);
      }
    }
    for (let k = 0; k < g.unicode.length; k++) map.push(gi);
    text += g.unicode;
    prev = g;
  }
  return { text, map, unknown };
}

function separator(p: GlyphRef, g: GlyphRef): '' | ' ' | '\n' {
  const len = Math.hypot(p.dx, p.dy);
  const h = Math.max(p.h, g.h, 0.1);
  if (len < 1e-6) return Math.hypot(g.x - p.x, g.y - p.y) > h ? '\n' : '';
  const ux = p.dx / len;
  const uy = p.dy / len;
  const rx = g.x - p.x;
  const ry = g.y - p.y;
  const perp = Math.abs(rx * -uy + ry * ux);
  if (perp > h * 0.5) return '\n';
  const along = (g.x - (p.x + p.dx)) * ux + (g.y - (p.y + p.dy)) * uy;
  if (along < -h * 1.5) return '\n';
  if (/\s$/u.test(p.unicode ?? '') || /^\s/u.test(g.unicode ?? '')) return '';
  const cjk = isCjk(p.unicode ?? '') && isCjk(g.unicode ?? '');
  return along > h * (cjk ? 0.9 : 0.2) ? ' ' : '';
}

export { PDFName };
