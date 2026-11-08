import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFRef } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { importPdf, imgRef, loadEditable } from '../../src/infra/pdf/document';
import { ocrText } from '../../src/infra/pdf/images';
import { exportMaskedPdf } from '../../src/infra/pdf/mask';
import { restorePdf } from '../../src/infra/pdf/restore';
import { buildTextModel } from '../../src/infra/pdf/textmodel';
import { run } from './helpers';
import { fullEnv, imageEnv, JP_FONT, ocr, textImage } from './pdf-env';

// 画像の中の文字を OCR で読み、塗りつぶしてラベルを書き、元に戻す（Tesseract を実際に動かすので少し時間がかかる）

async function imagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const jp = await doc.embedFont(JP_FONT, { subset: true });
  const page = doc.addPage([595, 842]);
  page.drawText('添付の名刺を参照してください。', { x: 50, y: 790, size: 12, font: jp });
  const png = await doc.embedPng(textImage(['営業部の担当は田中花子さんです', '電話 090-1234-5678']));
  page.drawImage(png, { x: 50, y: 600, width: 320, height: png.height / 2 });
  return doc.save();
}

async function ocrOfImage(pdf: Uint8Array, ref: PDFRef) {
  const [img] = await imageEnv.decode(pdf, [ref]);
  return ocrText(await ocr.recognize(img!)).text.replace(/\s+/g, '');
}

afterAll(async () => {
  await ocr.terminate();
});

describe('PDF の中の画像', () => {
  it('画像の文字を読み、本文と一緒に検査し、塗りつぶしてラベルを書く。元に戻すと元の画素になる', async () => {
    const src = await importPdf('名刺.pdf', await imagePdf(), imageEnv);
    expect(src.blockers).toEqual([]);
    expect(src.text).toContain('【ページ 1・画像 1】');
    const compact = src.text.replace(/\s+/g, '');
    expect(compact).toContain('田中花子');
    expect(compact).toContain('090-1234-5678');

    const result = await run(src.text);
    const changed = result.segments.filter((s) => s.kind === 'changed').map((s) => s.kind === 'changed' && s.original.replace(/\s+/g, ''));
    expect(changed, JSON.stringify(src.text)).toEqual(expect.arrayContaining(['田中花子', '090-1234-5678']));

    const masked = await exportMaskedPdf(src, result.segments, fullEnv);
    expect(masked.maskedImages).toHaveLength(1);
    const ref = imgRef(src.images[0]!);
    const after = await ocrOfImage(masked.bytes, ref);
    expect(after).not.toContain('田中花子');
    expect(after).not.toContain('090-1234-5678');
    expect(after).toContain('電話');

    // 本文の文字の位置は変わらない
    const before = buildTextModel(await loadEditable(src.base));
    const out = buildTextModel(await loadEditable(masked.bytes));
    expect(out.glyphs[0]!.x).toBeCloseTo(before.glyphs[0]!.x, 3);

    const back = await restorePdf(
      { fileName: masked.fileName, bytes: masked.bytes, restoreMap: result.restoreMap, generalizedMap: result.generalizedMap, original: { base: src.base, maskedImages: masked.maskedImages } },
      fullEnv,
    );
    expect(back.images).toBe(1);
    const restored = await ocrOfImage(back.bytes, ref);
    expect(restored).toContain('田中花子');
  }, 120_000);
});
