import type { OcrEngine, OcrLine, Rgba } from './pdf/images';

// 画像の中の文字を端末内で読む（Tesseract.js・日本語）。PDF の画像と画像ファイル（Issue #11）で共通に使う。
// 文字1つずつの位置（symbols）まで取り、マスクする箱の位置に使う。

type TesseractModule = typeof import('tesseract.js');

export type TesseractOptions = {
  tesseract: TesseractModule;
  /** 画像を Tesseract に渡せる形（PNG など）にする */
  encode(image: Rgba): Promise<unknown>;
  workerOptions?: Record<string, unknown>;
  /** 信頼度がこれより低い文字も、マスクの取りこぼしを避けるため捨てない（検出側で判断する） */
};

export function tesseractOcr(opts: TesseractOptions): OcrEngine & { terminate(): Promise<void> } {
  let worker: Awaited<ReturnType<TesseractModule['createWorker']>> | null = null;
  const get = async () => {
    // OEM 1 = LSTM のみ
    worker ??= await opts.tesseract.createWorker('jpn', 1, { cacheMethod: 'none', gzip: true, ...(opts.workerOptions ?? {}) });
    return worker;
  };
  return {
    async recognize(image) {
      const w = await get();
      const { data } = await w.recognize((await opts.encode(image)) as never, {}, { blocks: true, text: false });
      const lines: OcrLine[] = [];
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            const chars = line.words.flatMap((word) =>
              word.symbols.filter((s) => s.text.trim()).map((s) => ({ text: s.text, x0: s.bbox.x0, y0: s.bbox.y0, x1: s.bbox.x1, y1: s.bbox.y1 })),
            );
            if (chars.length) lines.push({ chars });
          }
        }
      }
      return lines;
    },
    async terminate() {
      if (worker) await worker.terminate();
      worker = null;
    },
  };
}
