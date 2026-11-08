import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFDocument, type PDFObject } from 'pdf-lib';
import { arrayNumbers, dictGet, getArray, getDict, getName, getNumber, inherited, N, resolve } from './objects';
import { applyPoint, type Matrix } from './textmodel';

// 本文の外に元の文字が残る部品を取り除く（Issue #9 の「隠したい情報を残さない」）。
// - 注釈は見た目どおりに本文へ焼き込んでから消す（flattenAnnotations）。焼き込んだ文字も検査・加工の対象になる
// - ファイル情報・XMP・しおり・フォーム・埋め込みファイル・構造タグ・代替テキストなどは消す
// - どこからも参照されなくなった部品は、ファイルに書き出さない

const HIDDEN = 2;
const NO_VIEW = 32;

/** 注釈の外観（AP の N）を本文の最後に描き、注釈そのものは消す */
export function flattenAnnotations(doc: PDFDocument): number {
  const ctx = doc.context;
  let count = 0;
  for (const page of doc.getPages()) {
    const leaf = page.node;
    const annots = getArray(ctx, leaf, 'Annots');
    if (!annots) continue;
    let ops = '';
    const xobjects: [string, PDFRef][] = [];
    for (let i = 0; i < annots.size(); i++) {
      const annot = resolve(ctx, annots.get(i));
      if (!(annot instanceof PDFDict)) continue;
      const flags = getNumber(ctx, annot, 'F') ?? 0;
      const subtype = getName(ctx, annot, 'Subtype');
      if (flags & (HIDDEN | NO_VIEW) || subtype === 'Popup') continue;
      const ap = getDict(ctx, annot, 'AP');
      let normal = ap?.get(N('N'));
      let normalObj = resolve(ctx, normal);
      if (normalObj instanceof PDFDict && !(normalObj instanceof PDFStream)) {
        const state = getName(ctx, annot, 'AS');
        normal = state ? normalObj.get(N(state)) : undefined;
        normalObj = resolve(ctx, normal);
      }
      if (!(normalObj instanceof PDFStream) || !(normal instanceof PDFRef)) continue;
      const rect = arrayNumbers(ctx, getArray(ctx, annot, 'Rect'));
      const bbox = arrayNumbers(ctx, getArray(ctx, normalObj.dict, 'BBox'));
      if (rect.length < 4 || bbox.length < 4) continue;
      const m = arrayNumbers(ctx, getArray(ctx, normalObj.dict, 'Matrix'));
      const matrix: Matrix = m.length === 6 ? (m as Matrix) : [1, 0, 0, 1, 0, 0];
      const corners = [applyPoint(matrix, bbox[0]!, bbox[1]!), applyPoint(matrix, bbox[2]!, bbox[1]!), applyPoint(matrix, bbox[0]!, bbox[3]!), applyPoint(matrix, bbox[2]!, bbox[3]!)];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
      if (bx1 - bx0 <= 0 || by1 - by0 <= 0) continue;
      const rx0 = Math.min(rect[0]!, rect[2]!), rx1 = Math.max(rect[0]!, rect[2]!), ry0 = Math.min(rect[1]!, rect[3]!), ry1 = Math.max(rect[1]!, rect[3]!);
      const sx = (rx1 - rx0) / (bx1 - bx0);
      const sy = (ry1 - ry0) / (by1 - by0);
      normalObj.dict.set(N('Type'), N('XObject'));
      normalObj.dict.set(N('Subtype'), N('Form'));
      const key = `TCAnnot${count++}`;
      xobjects.push([key, normal]);
      ops += `q ${sx} 0 0 ${sy} ${rx0 - bx0 * sx} ${ry0 - by0 * sy} cm /${key} Do Q\n`;
    }
    leaf.delete(N('Annots'));
    if (!ops) continue;
    // ページの資源を、このページ専用にしてから外観を登録する（親から継承した資源はほかのページと共有のため）
    const inheritedRes = inherited(ctx, leaf, 'Resources');
    const res = inheritedRes instanceof PDFDict ? (inheritedRes.clone(ctx) as PDFDict) : (ctx.obj({}) as PDFDict);
    const xo = getDict(ctx, res, 'XObject');
    const xoCopy = xo ? (xo.clone(ctx) as PDFDict) : (ctx.obj({}) as PDFDict);
    for (const [k, ref] of xobjects) xoCopy.set(N(k), ref);
    res.set(N('XObject'), xoCopy);
    leaf.set(N('Resources'), res);
    // 元の本文の描画状態が外観に影響しないよう、本文全体を q … Q で囲んでから外観を描く
    const contents = dictGet(ctx, leaf, 'Contents');
    const list: PDFObject[] = [];
    list.push(ctx.register(ctx.flateStream('q\n')));
    if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) list.push(contents.get(i));
    else if (leaf.get(N('Contents'))) list.push(leaf.get(N('Contents'))!);
    list.push(ctx.register(ctx.flateStream('Q\n' + ops)));
    leaf.set(N('Contents'), ctx.obj(list));
  }
  return count;
}

const CATALOG_DROP = ['Metadata', 'Outlines', 'Names', 'AcroForm', 'StructTreeRoot', 'MarkInfo', 'OpenAction', 'AA', 'PieceInfo', 'Threads', 'SpiderInfo', 'Perms', 'Legal', 'Collection', 'Dests', 'PageLabels', 'URI', 'AF', 'DSS'];
const PAGE_DROP = ['Annots', 'Thumb', 'PieceInfo', 'AA', 'Metadata', 'StructParents', 'B', 'ID', 'PZ', 'SeparationInfo', 'Tabs', 'TemplateInstantiated', 'PresSteps', 'AF'];
const XOBJECT_DROP = ['Metadata', 'PieceInfo', 'StructParent', 'StructParents', 'OPI', 'Alternates', 'Name', 'AF', 'LastModified'];
const MARKED_DROP = ['ActualText', 'Alt', 'E', 'T', 'Contents', 'MCID'];

export function sanitizeDocument(doc: PDFDocument) {
  const ctx = doc.context;
  const catalog = doc.catalog;
  for (const k of CATALOG_DROP) catalog.delete(N(k));

  // レイヤー名には文書固有の語が入りうるので、番号だけにする
  const oc = getDict(ctx, catalog, 'OCProperties');
  const ocgs = getArray(ctx, oc, 'OCGs');
  if (ocgs) {
    for (let i = 0; i < ocgs.size(); i++) {
      const g = resolve(ctx, ocgs.get(i));
      if (g instanceof PDFDict) g.set(N('Name'), PDFString.of(`Layer ${i + 1}`));
    }
  }

  for (const page of doc.getPages()) for (const k of PAGE_DROP) page.node.delete(N(k));

  // ファイル情報は空にする
  const info = ctx.obj({});
  ctx.trailerInfo.Info = ctx.register(info);
  delete (ctx.trailerInfo as { ID?: unknown }).ID;

  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      const subtype = getName(ctx, obj.dict, 'Subtype');
      const type = getName(ctx, obj.dict, 'Type');
      if (subtype === 'Image' || subtype === 'Form') for (const k of XOBJECT_DROP) obj.dict.delete(N(k));
      if (type === 'Metadata') obj.dict.delete(N('Type'));
      if (subtype === 'Image' && getName(ctx, obj.dict, 'Filter') === 'DCTDecode' && obj instanceof PDFRawStream) {
        stripJpegMetadata(obj);
      }
    } else if (obj instanceof PDFDict) {
      // 名前付きの属性リスト（/Properties）の代替テキストを消す
      for (const k of ['ActualText', 'Alt', 'E']) obj.delete(N(k));
    }
  }
}

/** 本文の BDC に直接書かれた属性（代替テキストなど）を消す。戻り値は書き換えたか */
export function stripMarkedContent(ops: { op: string; args: { t: string; entries?: [string, unknown][] }[] }[]): boolean {
  let changed = false;
  for (const o of ops) {
    if (o.op !== 'BDC' && o.op !== 'DP') continue;
    const props = o.args[1];
    if (props?.t === 'dict' && props.entries) {
      const before = props.entries.length;
      props.entries = props.entries.filter(([k]) => !MARKED_DROP.includes(k));
      if (props.entries.length !== before) changed = true;
    }
  }
  return changed;
}

/** JPEG の APPn（EXIF・XMP など）とコメントを除く。APP0（JFIF）と APP14（Adobe の色変換）は残す */
function stripJpegMetadata(stream: PDFRawStream) {
  const b = stream.contents;
  if (b[0] !== 0xff || b[1] !== 0xd8) return;
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return;
    const marker = b[i + 1]!;
    if (marker === 0xda) {
      keep.push(b.subarray(i));
      break;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    const seg = b.subarray(i, i + 2 + len);
    const isApp = marker >= 0xe1 && marker <= 0xef && marker !== 0xee;
    if (!isApp && marker !== 0xfe) keep.push(seg);
    i += 2 + len;
  }
  const size = keep.reduce((n, s) => n + s.length, 0);
  if (size === b.length) return;
  const out = new Uint8Array(size);
  let at = 0;
  for (const s of keep) {
    out.set(s, at);
    at += s.length;
  }
  (stream as unknown as { contents: Uint8Array }).contents = out;
  stream.dict.set(N('Length'), PDFNumber.of(size));
}

/** カタログとファイル情報からたどれない部品を消す */
export function collectGarbage(doc: PDFDocument) {
  const ctx = doc.context;
  const seen = new Set<string>();
  const queue: PDFObject[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter((o): o is PDFObject => !!o);
  while (queue.length) {
    const o = queue.pop()!;
    if (o instanceof PDFRef) {
      const key = o.tag;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = ctx.lookup(o);
      if (target) queue.push(target);
    } else if (o instanceof PDFStream) {
      queue.push(o.dict);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) queue.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) queue.push(o.get(i));
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

export { PDFName };
