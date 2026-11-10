import { paintedRect, type OcrChar, type Rgba } from './pdf/images';

// 画像の中の顔を見つける（Issue #11）。画像ファイルと PDF の中の画像で共通に使う。
// 検出器（ブラウザでは MediaPipe の BlazeFace）は 128 画素四方に縮めて見るため、大きな画像の中の小さな顔（スキャンした書類の顔写真など）を見逃しやすい。
// そこで画像全体に加えて、重なり合う正方形の切り出しでも探し、同じ顔の重複をまとめる。

/** 顔の箱。座標は画像の画素（左上が原点）。score は検出器の確からしさ（0〜1） */
export type FaceBox = { x0: number; y0: number; x1: number; y1: number; score: number };

/** 画像1枚から顔の箱を返す。切り出しや重複の整理は findFaces が行う */
export type RawFaceDetect = (image: Rgba) => Promise<FaceBox[]>;

export interface FaceDetector {
  detect(image: Rgba): Promise<FaceBox[]>;
}

/** これより小さい画像では顔を探さない（アイコンなど） */
const MIN_SIDE = 48;
/** 切り出しの最小の大きさ。検出器の入力（128 画素）より十分大きくする */
const MIN_TILE = 256;
/** 1枚の画像で検出器を呼ぶ上限（大きな画像で時間をかけすぎない） */
const MAX_CALLS = 40;

export function makeFaceDetector(raw: RawFaceDetect): FaceDetector {
  return { detect: (image) => findFaces(image, raw) };
}

export async function findFaces(image: Rgba, raw: RawFaceDetect): Promise<FaceBox[]> {
  const { width: w, height: h } = image;
  if (Math.min(w, h) < MIN_SIDE) return [];
  const found: FaceBox[] = [...(await raw(image))];
  let calls = 1;
  for (const size of tileSizes(w, h)) {
    for (const t of tiles(w, h, size)) {
      if (calls >= MAX_CALLS) break;
      calls++;
      for (const b of await raw(crop(image, t.x, t.y, t.size, t.size))) {
        found.push({ x0: b.x0 + t.x, y0: b.y0 + t.y, x1: b.x1 + t.x, y1: b.y1 + t.y, score: b.score });
      }
    }
  }
  return mergeBoxes(found).map((b) => padFace(b, w, h));
}

/** 切り出しの大きさ: 短い辺の 1/2、1/4 …（MIN_TILE まで） */
export function tileSizes(w: number, h: number): number[] {
  const out: number[] = [];
  for (let s = Math.floor(Math.min(w, h) / 2); s >= MIN_TILE; s = Math.floor(s / 2)) out.push(s);
  return out;
}

/** 半分ずつ重なる正方形の切り出し。最後の行・列は画像の端にそろえる */
export function tiles(w: number, h: number, size: number): { x: number; y: number; size: number }[] {
  const steps = (len: number) => {
    const out: number[] = [];
    const step = Math.max(1, Math.floor(size / 2));
    for (let p = 0; p + size < len; p += step) out.push(p);
    out.push(Math.max(0, len - size));
    return [...new Set(out)];
  };
  const out: { x: number; y: number; size: number }[] = [];
  for (const y of steps(h)) for (const x of steps(w)) out.push({ x, y, size: Math.min(size, w, h) });
  return out;
}

export function crop(img: Rgba, x: number, y: number, cw: number, ch: number): Rgba {
  const data = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const from = ((y + row) * img.width + x) * 4;
    data.set(img.data.subarray(from, from + cw * 4), row * cw * 4);
  }
  return { width: cw, height: ch, data };
}

const area = (b: FaceBox) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

function overlap(a: FaceBox, b: FaceBox) {
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = iw * ih;
  return { iou: inter / (area(a) + area(b) - inter || 1), cover: inter / (Math.min(area(a), area(b)) || 1) };
}

/** 同じ顔の重複（全体と切り出しの両方で見つかった・切り出しの境目で割れた）をまとめる。確からしい方の箱を残す */
export function mergeBoxes(boxes: FaceBox[]): FaceBox[] {
  const kept: FaceBox[] = [];
  for (const b of [...boxes].sort((p, q) => q.score - p.score)) {
    const same = kept.find((k) => {
      const o = overlap(k, b);
      return o.iou > 0.3 || o.cover > 0.6;
    });
    if (!same) kept.push({ ...b });
    else {
      // 切り出しの端で欠けた箱を、もう片方で補う
      same.x0 = Math.min(same.x0, b.x0);
      same.y0 = Math.min(same.y0, b.y0);
      same.x1 = Math.max(same.x1, b.x1);
      same.y1 = Math.max(same.y1, b.y1);
    }
  }
  // 読み順（上から、左から）にそろえ、番号が画面の並びと合うようにする
  return kept.sort((p, q) => (Math.abs(p.y0 - q.y0) > (p.y1 - p.y0) / 2 ? p.y0 - q.y0 : p.x0 - q.x0));
}

/** 検出器の箱は目鼻のまわりだけなので、額・髪・あごまで広げる */
export function padFace(b: FaceBox, w: number, h: number): FaceBox {
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  return {
    x0: Math.max(0, Math.floor(b.x0 - bw * 0.2)),
    y0: Math.max(0, Math.floor(b.y0 - bh * 0.35)),
    x1: Math.min(w, Math.ceil(b.x1 + bw * 0.2)),
    y1: Math.min(h, Math.ceil(b.y1 + bh * 0.15)),
    score: b.score,
  };
}

/** 取込結果に出す、顔の検出の結果 */
export function faceNotes(faces: unknown[], available: boolean): string[] {
  if (!available) return ['顔を見つける機能を使えない環境のため、顔は自動では隠していません。仕上がりの確認画面で、顔を四角形で囲んで隠してください。'];
  if (!faces.length) return ['顔は見つかりませんでした。横顔や小さな顔は見逃すことがあるので、仕上がりの確認画面で確かめてください。'];
  return [`顔を ${faces.length} 件見つけました。保存するときは塗りつぶして「[顔1]」などと書きます（出力先の欄で、顔ごとに残すこともできます）。`];
}

/** 顔を隠すときのラベル（番号は 1 から） */
export const faceLabel = (index: number) => `[顔${index + 1}]`;

// ---- 復元: AI などから戻ってきた画像の「[顔N]」の所に、元の顔を貼り戻す ----
// 自分が保存した画像そのものなら元の画素に戻す（呼び出し側）。手を加えられた画像では、ラベルを OCR で探し、
// ラベルの真ん中を目印に、塗りつぶした範囲に元の顔の画素を貼る。画像が縮んでいたら、同じ割合で縮めて貼る。

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * OCR した文章から「[顔N]」を探す。かっこは読み落とされやすいので「顔」と番号だけを手がかりにする。
 * index は 0 から。番号を読めなかったものは null（呼び出し側が位置で顔を決める）
 */
export function findFaceLabels(text: string, map: number[], chars: OcrChar[]): (Box & { index: number | null })[] {
  const out: (Box & { index: number | null })[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(/顔\s*([0-9０-９]+)?/g)) {
    const n = m[1] ? Number(m[1].replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))) - 1 : null;
    const index = n !== null && n >= 0 && !seen.has(n) ? n : null;
    const cs: OcrChar[] = [];
    for (let c = m.index; c < m.index + m[0].length; c++) {
      const v = map[c]!;
      if (v >= 0 && chars[v]) cs.push(chars[v]);
    }
    if (!cs.length) continue;
    if (index !== null) seen.add(index);
    out.push({ index, x0: Math.min(...cs.map((c) => c.x0)), y0: Math.min(...cs.map((c) => c.y0)), x1: Math.max(...cs.map((c) => c.x1)), y1: Math.max(...cs.map((c) => c.y1)) });
  }
  return out;
}

/**
 * 元の画像で塗った範囲（from）と、戻ってきた画像で貼る範囲（to）。
 * 縦横比が同じ（縮めただけ）で、ラベルが元の位置を同じ割合で移した範囲の中にあれば、その範囲に貼る。
 * そうでなければ（余白を足された・切られた・動かされた）、小さい方の割合で縮め、ラベルの真ん中に合わせる。
 * 縮めたときのにじみも隠れるよう、塗った範囲より 2 画素広く貼る
 */
export function faceTarget(face: FaceBox, label: Box, original: { width: number; height: number }, image: { width: number; height: number }): { from: Box; to: Box } {
  const r = paintedRect(face, original.width, original.height);
  const from = { x0: Math.max(0, r.x0 - 2), y0: Math.max(0, r.y0 - 2), x1: Math.min(original.width, r.x1 + 2), y1: Math.min(original.height, r.y1 + 2) };
  const sx = image.width / original.width;
  const sy = image.height / original.height;
  const cx = (label.x0 + label.x1) / 2;
  const cy = (label.y0 + label.y1) / 2;
  if (Math.abs(sx - sy) / sx < 0.03) {
    const to = { x0: Math.floor(from.x0 * sx), y0: Math.floor(from.y0 * sy), x1: Math.ceil(from.x1 * sx), y1: Math.ceil(from.y1 * sy) };
    if (cx >= to.x0 && cx <= to.x1 && cy >= to.y0 && cy <= to.y1) return { from, to };
  }
  const s = Math.min(sx, sy);
  // ラベルは塗った範囲の真ん中に書いてある
  const hw = ((from.x1 - from.x0) * s) / 2;
  const hh = ((from.y1 - from.y0) * s) / 2;
  const ox = ((r.x0 + r.x1) / 2 - (from.x0 + from.x1) / 2) * s;
  const oy = ((r.y0 + r.y1) / 2 - (from.y0 + from.y1) / 2) * s;
  return { from, to: { x0: Math.round(cx - ox - hw), y0: Math.round(cy - oy - hh), x1: Math.round(cx - ox + hw), y1: Math.round(cy - oy + hh) } };
}

/** src の from の範囲を、dst の to の範囲に引き伸ばして貼る（双線形）。dst の外にはみ出す分は捨てる */
export function pasteScaled(dst: Rgba, src: Rgba, from: Box, to: Box): void {
  const tw = to.x1 - to.x0;
  const th = to.y1 - to.y0;
  const fw = from.x1 - from.x0;
  const fh = from.y1 - from.y0;
  if (tw <= 0 || th <= 0 || fw <= 0 || fh <= 0) return;
  const px = (x: number, y: number, ch: number) => src.data[(y * src.width + x) * 4 + ch]!;
  for (let y = Math.max(0, to.y0); y < Math.min(dst.height, to.y1); y++) {
    const sy = Math.min(from.y1 - 1, Math.max(from.y0, from.y0 + ((y - to.y0 + 0.5) * fh) / th - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(from.y1 - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = Math.max(0, to.x0); x < Math.min(dst.width, to.x1); x++) {
      const sx = Math.min(from.x1 - 1, Math.max(from.x0, from.x0 + ((x - to.x0 + 0.5) * fw) / tw - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(from.x1 - 1, x0 + 1);
      const fx = sx - x0;
      const p = (y * dst.width + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = px(x0, y0, ch) * (1 - fx) + px(x1, y0, ch) * fx;
        const bottom = px(x0, y1, ch) * (1 - fx) + px(x1, y1, ch) * fx;
        dst.data[p + ch] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
}

/**
 * 戻ってきた画像（image）の「[顔N]」の所に、元の顔を貼り戻す。faces は取り込んだときに見つけた顔（番号は 0 から）、
 * originalOf は N 番目の顔が写っていた元の画像（PDF では顔ごとに元の画像が違う）。
 * 貼り戻した顔の番号を返す。image は書き換えずに新しい画像を返す
 */
export async function restoreFaces(
  image: Rgba,
  ocr: { text: string; map: number[]; chars: OcrChar[] },
  faces: FaceBox[],
  originalOf: (index: number) => Rgba | null | Promise<Rgba | null>,
): Promise<{ image: Rgba; restored: number[] }> {
  const hits = findFaceLabels(ocr.text, ocr.map, ocr.chars);
  const restored: number[] = [];
  let out: Rgba | null = null;
  const paste = async (index: number, label: Box) => {
    const face = faces[index];
    const original = face && (await originalOf(index));
    if (!face || !original || restored.includes(index)) return;
    out ??= { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
    const { from, to } = faceTarget(face, label, original, image);
    pasteScaled(out, original, from, to);
    restored.push(index);
  };
  // 番号を読めたものを先に、読めなかったもの（「顔」だけ・ない番号への読み違い）は、まだ戻していない顔のうち、
  // 元の位置を画像の大きさの割合で移した所がいちばん近いものに当てる
  const numbered = (h: (typeof hits)[number]) => h.index !== null && !!faces[h.index];
  for (const h of hits) if (numbered(h)) await paste(h.index!, h);
  for (const h of hits) {
    if (numbered(h)) continue;
    const cx = (h.x0 + h.x1) / 2;
    const cy = (h.y0 + h.y1) / 2;
    let best: { index: number; d: number } | null = null;
    for (let i = 0; i < faces.length; i++) {
      if (restored.includes(i)) continue;
      const original = await originalOf(i);
      if (!original) continue;
      const f = faces[i]!;
      const ex = (((f.x0 + f.x1) / 2) * image.width) / original.width;
      const ey = (((f.y0 + f.y1) / 2) * image.height) / original.height;
      const d = Math.hypot(ex - cx, ey - cy);
      // 顔の大きさより遠いものは、別の物とみなす
      const reach = Math.max(f.x1 - f.x0, f.y1 - f.y0) * Math.max(image.width / original.width, image.height / original.height);
      if (d <= reach && (!best || d < best.d)) best = { index: i, d };
    }
    if (best) await paste(best.index, h);
  }
  return { image: out ?? image, restored: restored.sort((p, q) => p - q) };
}
