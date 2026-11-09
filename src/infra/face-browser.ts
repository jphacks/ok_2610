import { assetUrl, readBundledAsset } from './assets';
import { makeFaceDetector, type FaceDetector } from './face';

// サイドパネルで顔を見つける検出器（MediaPipe の BlazeFace・端末内）。WASM とモデルは拡張に同梱したもの（wxt.config.ts）を読み、外部には取りに行かない。
// 読み込むときだけ起こし、終わったら close で止める。

export type BrowserFaceDetector = FaceDetector & { close(): void };

/** 顔を見逃しにくいよう、確からしさの下限は既定（0.5）より少し下げる。誤検出は画面で「残す」を選べる */
const MIN_CONFIDENCE = 0.4;

export async function openFaceDetector(): Promise<BrowserFaceDetector> {
  const vision = await import('@mediapipe/tasks-vision');
  const model = await readBundledAsset('face/blaze_face_short_range.tflite');
  const detector = await vision.FaceDetector.createFromOptions(
    { wasmLoaderPath: assetUrl('face/vision_wasm_internal.js'), wasmBinaryPath: assetUrl('face/vision_wasm_internal.wasm') },
    { baseOptions: { modelAssetBuffer: model, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: MIN_CONFIDENCE },
  );
  const faces = makeFaceDetector(async (img) => {
    const result = detector.detect(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height));
    return result.detections.flatMap((d) => {
      const b = d.boundingBox;
      if (!b || b.width <= 0 || b.height <= 0) return [];
      return [{ x0: b.originX, y0: b.originY, x1: b.originX + b.width, y1: b.originY + b.height, score: d.categories[0]?.score ?? 0 }];
    });
  });
  return { detect: faces.detect, close: () => detector.close() };
}
