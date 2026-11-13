// ブラウザ（Playwright の Chromium）で動かす顔の検出。アプリ（src/infra/face-browser.ts）と同じ検出器・同じ設定・同じ切り出し（findFaces）
import { FaceDetector } from '@mediapipe/tasks-vision';
import { findFaces } from '../src/infra/face';

let detector: FaceDetector;
const w = window as unknown as Record<string, unknown>;
w.init = async () => {
  const model = new Uint8Array(await (await fetch('/model.tflite')).arrayBuffer());
  detector = await FaceDetector.createFromOptions(
    { wasmLoaderPath: '/wasm/vision_wasm_internal.js', wasmBinaryPath: '/wasm/vision_wasm_internal.wasm' },
    { baseOptions: { modelAssetBuffer: model, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.4 },
  );
  return true;
};
w.detect = async (b64: string) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const img = { width: d.width, height: d.height, data: d.data };
  return findFaces(img, async (im) => {
    const r = detector.detect(new ImageData(new Uint8ClampedArray(im.data), im.width, im.height));
    return r.detections.flatMap((x) => {
      const b = x.boundingBox;
      if (!b || b.width <= 0 || b.height <= 0) return [];
      return [{ x0: b.originX, y0: b.originY, x1: b.originX + b.width, y1: b.originY + b.height, score: x.categories[0]?.score ?? 0 }];
    });
  });
};
