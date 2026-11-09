import fontkit from '@pdf-lib/fontkit';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { crop, faceLabel, faceTarget, findFaceLabels, findFaces, makeFaceDetector, mergeBoxes, padFace, pasteScaled, restoreFaces, tiles, tileSizes, type FaceBox } from '../../src/infra/face';
import { exportMaskedImage, IMAGE_ONLY_TEXT, importImage, restoreImage, type ImageFileEnv } from '../../src/infra/image/image';
import { imgRef, importPdf } from '../../src/infra/pdf/document';
import type { ImageEnv, Rgba } from '../../src/infra/pdf/images';
import { exportMaskedPdf } from '../../src/infra/pdf/mask';
import { restorePdf } from '../../src/infra/pdf/restore';
import { run, settings } from './helpers';
import { imageEnv, imageFileEnv, JP_FONT, ocr, toPng } from './pdf-env';

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

/** AI が手を加えた画像の代わり: 縮めて、隅に印を足す（自分が保存した画像とは別物になる） */
function aiEdit(img: Rgba, scale: number): Uint8Array {
  const src = createCanvas(img.width, img.height);
  src.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  ctx.fillStyle = '#3060ff';
  ctx.fillRect(0, 0, 6, 6);
  return new Uint8Array(c.encodeSync('png'));
}

describe('顔の復元（AI が手を加えた画像）', () => {
  it('「[顔N]」は、かっこや全角の番号を読み違えても見つける', () => {
    const text = '［顔１］と顔 2 と[顔1]';
    const chars = [...text].map((t, i) => ({ text: t, x0: i * 10, y0: 0, x1: i * 10 + 10, y1: 20 }));
    const hits = findFaceLabels(text, chars.map((_, i) => i), chars);
    expect(hits.map((h) => h.index)).toEqual([0, 1, null]);
    expect(hits[0]).toMatchObject({ x0: 10, x1: 30 });
  });

  it('番号を読み違えた「顔」は、元の位置にいちばん近い、まだ戻していない顔に当てる', async () => {
    const original: Rgba = { width: 400, height: 200, data: new Uint8ClampedArray(400 * 200 * 4).fill(200) };
    const image: Rgba = { width: 200, height: 100, data: new Uint8ClampedArray(200 * 100 * 4) };
    const faces = [
      { x0: 20, y0: 20, x1: 100, y1: 120, score: 1 },
      { x0: 260, y0: 20, x1: 340, y1: 120, score: 1 },
    ];
    // 右の顔の所に「顔」（番号は「間」と読み違え）、遠く離れた所にも「顔」
    const text = '顔間';
    const chars = [{ text: '顔', x0: 140, y0: 30, x1: 160, y1: 45 }, { text: '間', x0: 160, y0: 30, x1: 175, y1: 45 }];
    const back = await restoreFaces(image, { text, map: [0, 1], chars }, faces, () => original);
    expect(back.restored).toEqual([1]);
    const far = await restoreFaces(image, { text: '顔', map: [0], chars: [{ text: '顔', x0: 95, y0: 90, x1: 99, y1: 99 }] }, [faces[0]!], () => original);
    expect(far.restored).toEqual([]);
  });

  it('縮めただけの画像では元の位置を同じ割合で移した所に、動かされた画像ではラベルの真ん中に合わせて貼る', () => {
    const face = { x0: 100, y0: 100, x1: 200, y1: 220, score: 1 };
    const same = faceTarget(face, { x0: 120, y0: 150, x1: 140, y1: 170 }, { width: 400, height: 400 }, { width: 400, height: 400 });
    expect(same.to).toEqual(same.from);
    // 半分に縮めた画像。ラベルの読み取りが左に寄っていても、位置は縮めた割合で決まる
    const half = faceTarget(face, { x0: 60, y0: 75, x1: 70, y1: 85 }, { width: 400, height: 400 }, { width: 200, height: 200 });
    expect(half.to).toEqual({ x0: Math.floor(same.from.x0 / 2), y0: Math.floor(same.from.y0 / 2), x1: Math.ceil(same.from.x1 / 2), y1: Math.ceil(same.from.y1 / 2) });
    // 上に余白を足された画像（縦横比が違う）。ラベルの真ん中に合わせる
    const padded = faceTarget(face, { x0: 140, y0: 350, x1: 160, y1: 370 }, { width: 400, height: 400 }, { width: 400, height: 600 });
    expect((padded.to.x0 + padded.to.x1) / 2).toBeCloseTo(150, 0);
    expect((padded.to.y0 + padded.to.y1) / 2).toBeCloseTo(360, 0);
    expect(padded.to.x1 - padded.to.x0).toBe(same.from.x1 - same.from.x0);
  });

  it('貼り戻しは、同じ大きさなら元の画素をそのまま写す', () => {
    const src: Rgba = { width: 4, height: 4, data: Uint8ClampedArray.from({ length: 64 }, (_, i) => i * 3) };
    const dst: Rgba = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
    pasteScaled(dst, src, { x0: 1, y0: 1, x1: 3, y1: 3 }, { x0: 1, y0: 1, x1: 3, y1: 3 });
    expect(crop(dst, 1, 1, 2, 2).data).toEqual(crop(src, 1, 1, 2, 2).data);
    expect(dst.data[0]).toBe(0);
  });

  const env: ImageFileEnv = { ...imageFileEnv, faces: fakeFaces };

  it('画像ファイル: 縮められた画像でも、「[顔1]」の所に元の顔を貼り戻し、文字のラベルも戻す', async () => {
    const src = await importImage('社員証.png', photo({ text: '担当は田中花子さんです', face: { x: 400, y: 60, size: 140 } }), env);
    const result = await run(src.text, { settings: settings({ labelsOnly: true }) });
    const masked = await exportMaskedImage(src, result.segments, env);
    const fromAi = aiEdit(await env.decode(masked.bytes), 0.75);
    const back = await restoreImage(
      { fileName: 'answer.png', bytes: fromAi, restoreMap: result.restoreMap, generalizedMap: result.generalizedMap, original: { base: src.base, digest: masked.digest, faces: src.faces } },
      env,
    );
    expect(back.notes.join()).toContain('顔 1 件（[顔1]）');
    expect(back.unmatched).not.toContain('[顔1]');
    const img = await env.decode(back.bytes);
    expect(img.width).toBe(480);
    // 縮めた顔（140×0.75 = 105 四方）のほぼ全部が、元の色で、元の場所（の 0.75 倍）に戻る
    expect(countRed(img)).toBeGreaterThan(105 * 105 * 0.9);
    expect(countRed(img, { x0: 290, y0: 35, x1: 415, y1: 160 })).toBeGreaterThan(105 * 105 * 0.9);
  }, 120_000);

  it('画像ファイル: 元の顔の情報がなければ、顔は戻さない', async () => {
    const src = await importImage('社員証.png', photo({ text: '担当は田中花子さんです', face: { x: 400, y: 60, size: 140 } }), env);
    const result = await run(src.text, { settings: settings({ labelsOnly: true }) });
    const masked = await exportMaskedImage(src, result.segments, env);
    const fromAi = aiEdit(await env.decode(masked.bytes), 1);
    const back = await restoreImage({ fileName: 'answer.png', bytes: fromAi, restoreMap: result.restoreMap, generalizedMap: result.generalizedMap, original: { base: src.base, digest: masked.digest } }, env);
    expect(back.bytes.length ? countRed(await env.decode(back.bytes)) : 0).toBe(0);
  }, 120_000);

  it('PDF: 作り直された PDF の画像でも、「[顔1]」の所に元の顔を貼り戻す', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const jp = await doc.embedFont(JP_FONT, { subset: true });
    const page = doc.addPage([595, 842]);
    page.drawText('申込者の写真を添付します。', { x: 50, y: 790, size: 12, font: jp });
    const png = await doc.embedPng(photo({ text: '申込者 写真', face: { x: 240, y: 40, size: 150 } }));
    page.drawImage(png, { x: 50, y: 500, width: 320, height: 180 });
    const imgEnv: ImageEnv = { ...imageEnv, faces: fakeFaces };
    const src = await importPdf('申込書.pdf', await doc.save(), imgEnv);
    const result = await run(src.text, { settings: settings({ labelsOnly: true }) });
    const pdfEnv = { labelFont: async () => new Uint8Array(JP_FONT), images: imgEnv };
    const masked = await exportMaskedPdf(src, result.segments, pdfEnv);
    const [maskedImg] = await imgEnv.decode(masked.bytes, [imgRef(src.images[0]!)]);
    expect(countRed(maskedImg!)).toBe(0);

    // AI が作り直した PDF の代わり: 塗った画像を取り出して、新しい PDF に貼る
    const ai = await PDFDocument.create();
    const embedded = await ai.embedPng(toPng(maskedImg!));
    ai.addPage([595, 842]).drawImage(embedded, { x: 40, y: 400, width: 320, height: 180 });
    const back = await restorePdf(
      {
        fileName: 'answer.pdf',
        bytes: await ai.save(),
        restoreMap: result.restoreMap,
        generalizedMap: result.generalizedMap,
        original: {
          base: src.base,
          maskedImages: [],
          faces: src.faces.map((f) => ({ objectNumber: src.images[f.image]!.objectNumber, generation: src.images[f.image]!.generation, box: f.box })),
        },
      },
      pdfEnv,
    );
    expect(back.notes.join()).toContain('顔 1 件を、ラベルの位置に元の顔を貼って戻しました');
    const [after] = await imgEnv.decode(back.bytes, [embedded.ref]);
    expect(countRed(after!)).toBeGreaterThan(150 * 150 * 0.9);
  }, 180_000);
});
