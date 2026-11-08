import { PDFDict, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFFont } from 'pdf-lib';
import { zlibSync } from 'fflate';
import { formatNumber, name, num, serializeContent, str, type Op, type Token } from './lexer';
import { getDict, N, resolve } from './objects';
import type { GlyphRef, TextModel, Unit } from './textmodel';

// 文字を描画命令から取り除き、同じ幅だけ空けたうえで、そこに別の文字列（ラベル・元の語・書き直した文字）を書く（Issue #9）。
// 取り除いた文字の幅だけ TJ の数値で送るので、後ろの文字の位置は変わらない（レイアウトを保つ）。
// 書き込む文字列は、送り幅が元の幅に収まるよう横幅（Tz）と大きさを詰め、書いた分だけ戻してから元の状態に戻す。

export class PdfEditError extends Error {}

/** 1行の中の連続した文字を、text に置き換える。text が空なら取り除くだけ */
export type Piece = {
  glyphs: number[];
  text: string;
  /** 書き込みに使える幅（文字空間）。省略時は取り除く文字の幅。復元では、ラベルの後ろの空きも含めた幅を渡す */
  width?: number;
  /** 書き込む文字の大きさ。省略時は取り除く文字と同じ */
  size?: number;
};

/** 横幅はここまで詰める。これでも収まらないときだけ文字を小さくする（大きさをそろえるため） */
const MIN_SCALE = 35;

type Edit = {
  /** 取り除く文字（part ごとのバイト範囲） */
  removed: GlyphRef[];
  /** 文字の前に差し込む書き込み */
  inserts: Map<GlyphRef, { text: string; width: number; size?: number }>;
};

/** 置き換えを命令に反映する。書き換えたユニットを返す */
export function applyPieces(doc: PDFDocument, model: TextModel, pieces: Piece[], font: PDFFont): Set<Unit> {
  const edits = new Map<Unit, Map<number, Edit>>();
  for (const piece of pieces) {
    if (!piece.glyphs.length) continue;
    const gs = piece.glyphs.map((i) => model.glyphs[i]!);
    for (const g of gs) {
      if (g.vertical) throw new PdfEditError('縦書きの文字は加工できません');
      if (!g.state.fontName) throw new PdfEditError('フォントの指定方法に対応していない文字があります');
      if (!Number.isFinite(g.width)) throw new PdfEditError('幅の分からない文字があります');
      if (!g.state.size || !g.state.th) throw new PdfEditError('大きさが 0 の文字があります');
    }
    const first = gs[0]!;
    const unit = model.units[first.unit]!;
    const byOp = edits.get(unit) ?? new Map<number, Edit>();
    edits.set(unit, byOp);
    for (const g of gs) {
      if (g.unit !== first.unit) throw new PdfEditError('置き換える文字が複数のストリームにまたがっています');
      const e: Edit = byOp.get(g.op) ?? { removed: [], inserts: new Map() };
      byOp.set(g.op, e);
      e.removed.push(g);
    }
    if (piece.text) {
      byOp.get(first.op)!.inserts.set(first, { text: piece.text, width: piece.width ?? spanWidth(gs), size: piece.size });
    }
  }

  const ctx = doc.context;
  for (const [unit, byOp] of edits) {
    const labelRes = ensureFontResource(ctx, unit, font);
    const out: Op[] = [];
    unit.ops.forEach((o, i) => {
      const e = byOp.get(i);
      if (!e) out.push(o);
      else out.push(...rewriteShowOp(o, e, font, labelRes));
    });
    unit.ops = out;
    writeUnit(doc, unit);
  }
  return new Set(edits.keys());
}

/** 文字の並びの、文字空間での幅（最初の文字の向きで測る） */
export function spanWidth(gs: GlyphRef[]): number {
  const f = gs[0]!;
  const l = gs[gs.length - 1]!;
  const len = Math.hypot(f.dx, f.dy);
  if (gs.length === 1 || len < 1e-9) return gs.reduce((w, g) => w + g.adv, 0);
  const scale = len / Math.abs(f.adv || 1);
  const ux = f.dx / len;
  const uy = f.dy / len;
  const along = (l.x + l.dx - f.x) * ux + (l.y + l.dy - f.y) * uy;
  return along / scale;
}

/** Tj・'・" を TJ に直したうえで、取り除く文字を送り幅の数値に置き換え、書き込みを差し込む */
function rewriteShowOp(o: Op, e: Edit, font: PDFFont, labelRes: string): Op[] {
  const pre: Op[] = [];
  let items: Token[];
  if (o.op === 'TJ' && o.args[0]?.t === 'arr') items = o.args[0].items;
  else if (o.op === 'Tj' && o.args[0]) items = [o.args[0]];
  else if (o.op === "'" && o.args[0]) {
    pre.push({ op: 'T*', args: [] });
    items = [o.args[0]];
  } else if (o.op === '"' && o.args[2]) {
    pre.push({ op: 'Tw', args: [o.args[0]!] }, { op: 'Tc', args: [o.args[1]!] }, { op: 'T*', args: [] });
    items = [o.args[2]];
  } else return [o];

  const out: Op[] = [...pre];
  let cur: Token[] = [];
  const flush = () => {
    if (cur.length) out.push({ op: 'TJ', args: [{ t: 'arr', items: cur }] });
    cur = [];
  };
  const pushNum = (v: number) => {
    const last = cur[cur.length - 1];
    if (last?.t === 'num') cur[cur.length - 1] = num(last.v + v);
    else cur.push(num(v));
  };

  items.forEach((item, part) => {
    if (item.t !== 'str') {
      cur.push(item);
      return;
    }
    const removed = e.removed.filter((g) => g.part === part).sort((a, b) => a.start - b.start);
    let at = 0;
    for (const g of removed) {
      if (g.start > at) cur.push(str(item.bytes.slice(at, g.start)));
      const ins = e.inserts.get(g);
      if (ins) {
        flush();
        out.push(...writeText(ins.text, ins.width, g, font, labelRes, ins.size));
      }
      // TJ の数値 n は -n/1000 × 大きさ × Tz だけ進む。取り除いた文字の送り幅と同じだけ進める
      pushNum((-g.adv / (g.state.size * g.state.th)) * 1000);
      at = g.end;
    }
    if (at < item.bytes.length) cur.push(str(item.bytes.slice(at)));
  });
  flush();
  return out;
}

/** 文字列を、幅 width（文字空間）に収めて書き、書いた分だけ戻す。前後の文字の状態は元に戻す */
function writeText(text: string, width: number, g: GlyphRef, font: PDFFont, labelRes: string, baseSize?: number): Op[] {
  const st = g.state;
  if (width <= 0) return [];
  const base = baseSize ?? st.size;
  let size = base;
  const natural = font.widthOfTextAtSize(text, size);
  if (natural <= 0) return [];
  let hz = 100;
  let rise = st.ts + (base < st.size ? (st.size - base) * 0.3 : 0);
  if (natural > width) {
    hz = (width / natural) * 100;
    if (hz < MIN_SCALE) {
      size = base * (width / (natural * (MIN_SCALE / 100)));
      hz = MIN_SCALE;
      // 小さくした分だけ持ち上げて、行の高さの中ほどに置く
      rise = st.ts + (base - size) * 0.3;
    }
  }
  const advance = (font.widthOfTextAtSize(text, size) * hz) / 100;
  const encoded = font.encodeText(text);
  const hex = encoded.asString().replace(/[<>\s]/g, '');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return [
    { op: 'Tf', args: [name(labelRes), num(size)] },
    { op: 'Tz', args: [num(round(hz))] },
    { op: 'Tc', args: [num(0)] },
    { op: 'Tw', args: [num(0)] },
    ...(rise !== st.ts ? [{ op: 'Ts', args: [num(round(rise))] }] : []),
    { op: 'Tj', args: [str(bytes)] },
    ...(rise !== st.ts ? [{ op: 'Ts', args: [num(st.ts)] }] : []),
    { op: 'Tf', args: [name(st.fontName!), num(st.size)] },
    { op: 'Tz', args: [num(round(st.th * 100))] },
    { op: 'Tc', args: [num(st.tc)] },
    { op: 'Tw', args: [num(st.tw)] },
    // 書いた分を戻す（Tz を戻した後の単位で）
    { op: 'TJ', args: [{ t: 'arr', items: [num((advance / (st.size * st.th)) * 1000)] }] },
  ];
}

const round = (v: number) => Number(formatNumber(v));

/** ユニットの資源に、書き込み用のフォントを登録する。名前は既存と重ならないものにする */
function ensureFontResource(ctx: PDFContext, unit: Unit, font: PDFFont): string {
  let res = unit.resources;
  if (!res) {
    res = ctx.obj({});
    unit.resources = res;
    if (unit.kind === 'page' && unit.page) unit.page.set(N('Resources'), res);
    if (unit.kind === 'form' && unit.ref) {
      const s = ctx.lookup(unit.ref);
      if (s instanceof PDFStream) s.dict.set(N('Resources'), res);
    }
  }
  let fonts = getDict(ctx, res, 'Font');
  if (!fonts) {
    fonts = ctx.obj({});
    res.set(N('Font'), fonts);
  }
  for (const [k, v] of fonts.entries()) if (v instanceof PDFRef && v === font.ref) return k.decodeText();
  let n = 0;
  let key = 'TCLabel';
  while (fonts.get(N(key))) key = `TCLabel${++n}`;
  fonts.set(N(key), font.ref);
  return key;
}

/** ユニットの命令を書き戻す。ページは1本のストリームにまとめ、フォームは同じ参照の中身を差し替える */
export function writeUnit(doc: PDFDocument, unit: Unit) {
  const ctx = doc.context;
  const bytes = serializeContent(unit.ops);
  if (unit.kind === 'page' && unit.page) {
    const stream = ctx.flateStream(bytes);
    unit.page.set(N('Contents'), ctx.register(stream));
    return;
  }
  if (unit.kind === 'form' && unit.ref) {
    const old = resolve(ctx, unit.ref);
    if (!(old instanceof PDFStream)) return;
    const dict = ctx.obj({}) as PDFDict;
    for (const [k, v] of old.dict.entries()) {
      const key = k.decodeText();
      if (key === 'Length' || key === 'Filter' || key === 'DecodeParms') continue;
      dict.set(k, v);
    }
    dict.set(N('Filter'), N('FlateDecode'));
    ctx.assign(unit.ref, PDFRawStream.of(dict, zlibSync(bytes)));
  }
}
