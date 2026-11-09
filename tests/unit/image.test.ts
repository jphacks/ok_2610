import { afterAll, describe, expect, it } from 'vitest';
import { exportMaskedImage, importImage, ImageImportError, isImageFile, maskedImageName, restoredImageName, restoreImage } from '../../src/infra/image/image';
import { ocrText } from '../../src/infra/pdf/images';
import { run, settings } from './helpers';
import { imageFileEnv, ocr, textImage } from './pdf-env';

// 画像ファイル（Issue #11）: PDF の画像と同じ部品で、OCR で読み・塗りつぶしてラベルを書き・元に戻す（Tesseract を実際に動かすので少し時間がかかる）

afterAll(async () => {
  await ocr.terminate();
});

async function readBack(bytes: Uint8Array) {
  const img = await imageFileEnv.decode(bytes);
  return ocrText(await ocr.recognize(img)).text.replace(/\s+/g, '');
}

describe('画像ファイル', () => {
  it('拡張子とファイル名', () => {
    expect(isImageFile('名刺.PNG')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('a.gif')).toBe(false);
    expect(maskedImageName('名刺.jpg')).toBe('名刺_加工済み.png');
    expect(restoredImageName('名刺_加工済み.png')).toBe('名刺_復元済み.png');
  });

  it('対応していない形式は読まない', async () => {
    await expect(importImage('a.gif', new Uint8Array([1]), imageFileEnv)).rejects.toBeInstanceOf(ImageImportError);
  });

  it('画像の文字を読み、塗りつぶしてラベルを書く。加工した画像を戻すと元の画像になり、AI が作った画像は OCR でラベルを戻す', async () => {
    const png = new Uint8Array(textImage(['営業部の担当は田中花子さんです', '電話 090-1234-5678']));
    const src = await importImage('名刺.png', png, imageFileEnv);
    const compact = src.text.replace(/\s+/g, '');
    expect(compact).toContain('田中花子');
    expect(compact).toContain('090-1234-5678');

    const result = await run(src.text, { settings: settings({ labelsOnly: true }) });
    const changed = result.segments.flatMap((s) => (s.kind === 'changed' ? [s.original.replace(/\s+/g, '')] : []));
    expect(changed, JSON.stringify(src.text)).toEqual(expect.arrayContaining(['田中花子', '090-1234-5678']));

    const masked = await exportMaskedImage(src, result.segments, imageFileEnv);
    expect(masked.fileName).toBe('名刺_加工済み.png');
    const after = await readBack(masked.bytes);
    expect(after).not.toContain('田中花子');
    expect(after).not.toContain('090-1234-5678');
    expect(after).toContain('電話');

    // 自分が加工した画像そのもの → 元の画素に戻す
    const own = await restoreImage(
      { fileName: masked.fileName, bytes: masked.bytes, restoreMap: result.restoreMap, generalizedMap: result.generalizedMap, original: { base: src.base, digest: masked.digest } },
      imageFileEnv,
    );
    expect(own.images).toBe(1);
    expect(own.fileName).toBe('名刺_復元済み.png');
    const ownImg = await imageFileEnv.decode(own.bytes);
    expect(ownImg.data).toEqual(src.base.data);

    // AI が作った別の画像（ラベル入り） → OCR でラベルを探して元の語を描く
    const label = Object.keys(result.restoreMap).find((k) => result.restoreMap[k]!.replace(/\s+/g, '') === '田中花子')!;
    expect(label).toBeTruthy();
    const aiImage = new Uint8Array(textImage([`担当は${label}です`]));
    const back = await restoreImage({ fileName: 'answer.png', bytes: aiImage, restoreMap: result.restoreMap, generalizedMap: result.generalizedMap }, imageFileEnv);
    expect(back.replaced).toBeGreaterThanOrEqual(1);
    // 元の語はラベルの幅に詰めて描くので、読み直しの OCR は崩れることがある。ラベルが消えたことを確かめる
    expect(await readBack(back.bytes)).not.toContain(label.replace(/\s+/g, ''));

    // ラベルのない画像は、戻すものがない
    const none = await restoreImage({ fileName: 'x.png', bytes: new Uint8Array(textImage(['関係のない画像です'])), restoreMap: result.restoreMap, generalizedMap: result.generalizedMap }, imageFileEnv);
    expect(none.replaced + none.images).toBe(0);
  }, 120_000);

  it('手動で囲んだ四角形の画素を塗る', async () => {
    const png = new Uint8Array(textImage(['社外秘の資料です']));
    const src = await importImage('memo.png', png, imageFileEnv);
    const result = await run(src.text, { settings: settings({ labelsOnly: true }) });
    const masked = await exportMaskedImage(src, result.segments, imageFileEnv, [{ x0: 0, y0: 0, x1: src.width, y1: src.height }]);
    expect(masked.notes.join()).toContain('手動');
    expect(await readBack(masked.bytes)).not.toContain('社外秘');
  }, 120_000);
});
