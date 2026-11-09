import fontkit from '@pdf-lib/fontkit';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { crop, faceLabel, findFaces, makeFaceDetector, mergeBoxes, padFace, tiles, tileSizes, type FaceBox } from '../../src/infra/face';
import { exportMaskedImage, IMAGE_ONLY_TEXT, importImage, type ImageFileEnv } from '../../src/infra/image/image';
import { imgRef, importPdf } from '../../src/infra/pdf/document';
import type { ImageEnv, Rgba } from '../../src/infra/pdf/images';
import { exportMaskedPdf } from '../../src/infra/pdf/mask';
import { run, settings } from './helpers';
import { imageEnv, imageFileEnv, JP_FONT, ocr } from './pdf-env';

// 顔の検出と、見つけた顔の塗りつぶし（Issue #11）。
// 検出器そのもの（MediaPipe）はブラウザでしか動かないので、ここでは「赤い四角を顔とみなす」検出器で、切り出し・重複の整理・塗りつぶしを確かめる

afterAll(async () => {
  await ocr.terminate();
});

/** 赤い画素のかたまりを1つの顔とみなす。小さすぎるもの（画像の 1/12 未満）は、本物の検出器と同じく見逃す */
const redSquare = (img: Rgba): Promise<FaceBox[]> => {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      if (img.data[p]! > 200 && img.data[p + 1]! < 60 && img.data[p + 2]! < 60) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
    }
  }
  if (x1 < 0 || x1 - x0 < Math.min(img.width, img.height) / 12) return Promise.resolve([]);
  return Promise.resolve([{ x0, y0, x1, y1, score: 0.9 }]);
};
const fakeFaces = makeFaceDetector(redSquare);

function countRed(img: Rgba, box?: { x0: number; y0: number; x1: number; y1: number }): number {
  let n = 0;
  for (let y = box?.y0 ?? 0; y < (box?.y1 ?? img.height); y++) {
    for (let x = box?.x0 ?? 0; x < (box?.x1 ?? img.width); x++) {
      const p = (y * img.width + x) * 4;
      if (img.data[p]! > 200 && img.data[p + 1]! < 60 && img.data[p + 2]! < 60) n++;
    }
  }
  return n;
}

/** 白地に文字と赤い四角（顔の代わり）を描いた PNG */
function photo(opts: { text?: string; face: { x: number; y: number; size: number }; width?: number; height?: number }): Uint8Array {
  const w = opts.width ?? 640;
  const h = opts.height ?? 360;
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#e00000';
  ctx.fillRect(opts.face.x, opts.face.y, opts.face.size, opts.face.size);
  if (opts.text) {
    ctx.fillStyle = '#000000';
    ctx.font = '28px TCLabelFont';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.text, 20, h - 60);
  }
  return new Uint8Array(c.encodeSync('png'));
}

describe('顔の検出（切り出しと重複の整理）', () => {
  it('切り出しは半分ずつ重なり、画像の端までを覆う', () => {
    expect(tileSizes(400, 300)).toEqual([]);
    expect(tileSizes(2000, 1200)).toEqual([600, 300]);
    const ts = tiles(1000, 600, 300);
    expect(ts.every((t) => t.x + t.size <= 1000 && t.y + t.size <= 600)).toBe(true);
    expect(Math.max(...ts.map((t) => t.x + t.size))).toBe(1000);
    expect(Math.max(...ts.map((t) => t.y + t.size))).toBe(600);
  });

  it('切り出しは元の画素をそのまま写す', () => {
    const img: Rgba = { width: 3, height: 2, data: Uint8ClampedArray.from({ length: 24 }, (_, i) => i) };
    expect([...crop(img, 1, 1, 2, 1).data]).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it('重なる箱は1つにまとめ、離れた箱は別の顔として上から順に並べる', () => {
    const merged = mergeBoxes([
      { x0: 100, y0: 100, x1: 150, y1: 150, score: 0.6 },
      { x0: 0, y0: 0, x1: 40, y1: 40, score: 0.7 },
      { x0: 102, y0: 98, x1: 152, y1: 149, score: 0.9 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.x0).toBe(0);
    expect(merged[1]).toMatchObject({ x0: 100, y0: 98, x1: 152, y1: 150, score: 0.9 });
  });

  it('箱は額・あごまで広げ、画像の外には出さない', () => {
    expect(padFace({ x0: 10, y0: 10, x1: 110, y1: 110, score: 1 }, 115, 200)).toEqual({ x0: 0, y0: 0, x1: 115, y1: 125, score: 1 });
  });

  it('全体では小さすぎて見逃す顔も、切り出しで見つける', async () => {
    // 2000×1200 の書類の中の 80 画素の顔写真（全体の 1/15）
    const w = 2000, h = 1200;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 900; y < 980; y++) for (let x = 1500; x < 1580; x++) data.set([224, 0, 0, 255], (y * w + x) * 4);
    const img = { width: w, height: h, data };
    expect(await redSquare(img)).toEqual([]);
    const faces = await findFaces(img, redSquare);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.x0).toBeLessThanOrEqual(1500);
    expect(faces[0]!.x1).toBeGreaterThanOrEqual(1580);
  });

  it('ラベルは 1 から数える', () => {
    expect(faceLabel(0)).toBe('[顔1]');
  });
});

describe('画像ファイルの顔', () => {
  const env: ImageFileEnv = { ...imageFileEnv, faces: fakeFaces };

  it('見つけた顔を既定で塗りつぶしてラベルを書き、残すと選んだ顔はそのまま残す', async () => {
    const src = await importImage('社員証.png', photo({ text: '担当は田中花子さんです', face: { x: 400, y: 60, size: 140 } }), env);
    expect(src.faces).toHaveLength(1);
    expect(src.notes.join()).toContain('顔を 1 件見つけました');
    const result = await run(src.text, { settings: settings({ labelsOnly: true }) });

    const masked = await exportMaskedImage(src, result.segments, env);
    expect(masked.notes.join()).toContain('顔 1 件を塗りつぶしました');
    expect(countRed(await env.decode(masked.bytes))).toBe(0);

    const kept = await exportMaskedImage(src, result.segments, env, [], [0]);
    expect(countRed(await env.decode(kept.bytes))).toBe(140 * 140);
  }, 120_000);

  it('文字のない顔写真も取り込み、顔を隠して保存できる', async () => {
    const src = await importImage('顔写真.png', photo({ face: { x: 200, y: 80, size: 160 } }), env);
    expect(src.text).toBe(IMAGE_ONLY_TEXT);
    expect(src.faces).toHaveLength(1);
    const result = await run(src.text, { settings: settings({ labelsOnly: true }) });
    const masked = await exportMaskedImage(src, result.segments, env);
    expect(countRed(await env.decode(masked.bytes))).toBe(0);
  }, 120_000);

  it('検出器のない環境では顔を探さず、そのことを取込結果に書く', async () => {
    const src = await importImage('社員証.png', photo({ text: '担当は田中花子さんです', face: { x: 400, y: 60, size: 140 } }), imageFileEnv);
    expect(src.faces).toEqual([]);
    expect(src.notes.join()).toContain('顔を見つける機能を使えない環境');
  }, 120_000);
});

describe('PDF の中の画像の顔', () => {
  it('画像の中の顔を見つけて塗りつぶす。残すと選べばそのまま', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const jp = await doc.embedFont(JP_FONT, { subset: true });
    const page = doc.addPage([595, 842]);
    page.drawText('申込者の写真を添付します。', { x: 50, y: 790, size: 12, font: jp });
    const png = await doc.embedPng(photo({ text: '申込者 写真', face: { x: 240, y: 40, size: 150 } }));
    page.drawImage(png, { x: 50, y: 500, width: 320, height: 180 });
    const env: ImageEnv = { ...imageEnv, faces: fakeFaces };
    const src = await importPdf('申込書.pdf', await doc.save(), env);
    expect(src.faces).toHaveLength(1);
    expect(src.faces[0]!.image).toBe(0);

    const result = await run(src.text, { settings: settings({ labelsOnly: true }) });
    const pdfEnv = { labelFont: async () => new Uint8Array(JP_FONT), images: env };
    const masked = await exportMaskedPdf(src, result.segments, pdfEnv);
    expect(masked.notes.join()).toContain('顔 1 件を塗りつぶしました');
    const [after] = await env.decode(masked.bytes, [imgRef(src.images[0]!)]);
    expect(countRed(after!)).toBe(0);

    const kept = await exportMaskedPdf(src, result.segments, pdfEnv, [], [0]);
    const [still] = await env.decode(kept.bytes, [imgRef(src.images[0]!)]);
    expect(countRed(still!)).toBeGreaterThan(100 * 100);
  }, 120_000);
});
