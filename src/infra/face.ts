import type { Rgba } from './pdf/images';

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
