import { assetUrl, readBundledAsset } from './assets';
import { makeFaceDetector, type FaceDetector } from './face';

// サイドパネルで顔を見つける検出器（MediaPipe の BlazeFace・端末内）。WASM とモデルは拡張に同梱したもの（wxt.config.ts）を読み、外部には取りに行かない。
// 読み込むときだけ起こし、終わったら close で止める。

export type BrowserFaceDetector = FaceDetector & { close(): void };

/** 顔を見逃しにくいよう、確からしさの下限は既定（0.5）より少し下げる。誤検出は画面で「残す」を選べる */
const MIN_CONFIDENCE = 0.4;

// MediaPipe の WASM は、顔を探す準備のたびに害のない記録を出し、Chrome の拡張機能のエラー一覧に毎回並ぶ。顔の検出の結果には影響しない。
// - glog の知らせ・警告（「W1109 15:00:35.900000 2191552 gl_context.cc:1135] OpenGL error checking is disabled」）: グローバルの dbg があればそこへ、なければ console.warn へ出す
// - TensorFlow Lite の知らせ（「INFO: Created TensorFlow Lite XNNPACK delegate for CPU.」）: 読み込んだときに取っておいた console.error へ出す
// これらだけを捨て、エラー（glog の E・F）とそれ以外はそのまま出す。

/** glog の形式の行。先頭の文字が重さ（I・W・E・F） */
const GLOG_LINE = /^([IWEF])\d{4} \d{2}:\d{2}:\d{2}\.\d+ +\d+ [^\]]+\] /;

/** 捨ててよい MediaPipe の記録か */
export function isMediapipeNoise(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  if (text.startsWith('INFO: ')) return true;
  const m = GLOG_LINE.exec(text);
  return !!m && (m[1] === 'I' || m[1] === 'W');
}

/** MediaPipe の読み込み部（vision_wasm_internal.js）が記録を渡すグローバルの dbg */
export function mediapipeLog(text: string): void {
  if (!isMediapipeNoise(text)) console.warn(text);
}

let loading = 0;
let originalError: typeof console.error | null = null;

/**
 * 読み込み部は、読み込んだときの console.error を取っておいて使う。読み込む間だけ console.error を差し替え、
 * 取っておかれるのを、捨てるものを除く版にする。終わったら元に戻すので、拡張のほかの所には影響しない
 */
async function loadQuietly<T>(load: () => Promise<T>): Promise<T> {
  const g = globalThis as { dbg?: unknown };
  if (g.dbg === undefined) g.dbg = mediapipeLog;
  if (loading++ === 0) {
    const error = (originalError = console.error);
    console.error = (...args: unknown[]) => {
      if (!isMediapipeNoise(args[0])) error.apply(console, args);
    };
  }
  try {
    return await load();
  } finally {
    if (--loading === 0 && originalError) {
      console.error = originalError;
      originalError = null;
    }
  }
}

export async function openFaceDetector(): Promise<BrowserFaceDetector> {
  const vision = await import('@mediapipe/tasks-vision');
  const model = await readBundledAsset('face/blaze_face_short_range.tflite');
  const detector = await loadQuietly(() =>
    vision.FaceDetector.createFromOptions(
      { wasmLoaderPath: assetUrl('face/vision_wasm_internal.js'), wasmBinaryPath: assetUrl('face/vision_wasm_internal.wasm') },
      { baseOptions: { modelAssetBuffer: model, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: MIN_CONFIDENCE },
    ),
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
