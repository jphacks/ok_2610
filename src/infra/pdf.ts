// PDF を端末内で読み、本文の文字を解析用の文章にする（Issue #9）。
// 取り込むのはページ上の文字（テキストレイヤー）だけ。画像の中の文字・注釈・フォームの値は取り込まず、notes で利用者に伝える。
// 出力は加工後の文章（コピー・挿入）だけで、PDF としては保存しない。
// PDF.js は大きいので、PDF を選んだときにだけ読み込む。

export class PdfError extends Error {}

/** これより大きい PDF は開かない（Excel・CSV と同じ） */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** これより多いページは読まない。長すぎる文章は解析も確認も現実的でないため */
export const MAX_PDF_PAGES = 300;

export const PDF_EXTENSION = '.pdf';

export type PdfImport = { text: string; notes: string[]; pageCount: number };

/** PDF.js の getTextContent が返す項目のうち、使うものだけ */
export type PdfTextItem = { str: string; hasEOL?: boolean };

/** 1ページ分の項目を文章にする。PDF.js が行末に hasEOL を付けるので、そこで改行する */
export function pageItemsToText(items: readonly PdfTextItem[]): string {
  let out = '';
  for (const item of items) {
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  // 行末の空白（全角を含む。trimEnd が落とす）を除き、3行以上の空行を1つにする
  return out
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ページごとの文章を1つにまとめる。見出し「【ページ n】」は Excel の「【シート: 名前】」に合わせる */
export function joinPages(pages: readonly string[], totalPages: number): PdfImport {
  const notes: string[] = [];
  const blocks: string[] = [];
  const empty: number[] = [];
  pages.forEach((text, i) => {
    if (text) blocks.push(`【ページ ${i + 1}】\n${text}`);
    else empty.push(i + 1);
  });
  if (!blocks.length) {
    throw new PdfError('PDF から文字を取り出せませんでした。スキャンした画像だけの PDF は、今は読めません。');
  }
  notes.push('ページ上の文字だけを取り込みました。画像の中の文字・注釈（コメント）・フォームの入力値は検査していません。');
  if (empty.length) {
    notes.push(`文字のないページがあります（${formatPages(empty)}）。画像だけのページは検査していません。`);
  }
  if (totalPages > pages.length) {
    notes.push(`${pages.length} ページまでを取り込みました。${pages.length + 1} ページ以降（全 ${totalPages} ページ）は検査していません。`);
  }
  notes.push('加工結果は文章として出力します。PDF としては保存しません。');
  return { text: blocks.join('\n\n'), notes, pageCount: totalPages };
}

function formatPages(pages: number[]): string {
  const shown = pages.slice(0, 10).map((p) => `${p}`).join('・');
  return pages.length > 10 ? `${shown} ほか ${pages.length - 10} ページ` : `${shown} ページ`;
}

type PdfJs = typeof import('pdfjs-dist');

export type ExtractOptions = {
  /** Adobe の CMap（日本語フォントの文字の対応表）の置き場所。末尾は / */
  cMapUrl?: string;
  /** 解析を任せる Worker。省略時は PDF.js に任せる（テスト用） */
  worker?: InstanceType<PdfJs['PDFWorker']>;
};

/** PDF の中身から文字を取り出す。PDF.js を引数で受け取るのは、Node のテストでも同じ処理を通すため */
export async function extractPdfText(pdfjs: PdfJs, bytes: Uint8Array, options: ExtractOptions = {}): Promise<PdfImport> {
  const task = pdfjs.getDocument({
    data: bytes,
    worker: options.worker,
    cMapUrl: options.cMapUrl,
    cMapPacked: true,
    // 文字を取り出すだけなので、フォントは読み込まない
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
  });
  try {
    const doc = await task.promise;
    const total = doc.numPages;
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(total, MAX_PDF_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(pageItemsToText(content.items.flatMap((it) => ('str' in it ? [{ str: it.str, hasEOL: it.hasEOL }] : []))));
      page.cleanup();
    }
    return joinPages(pages, total);
  } catch (e) {
    if (e instanceof PdfError) throw e;
    if (e instanceof pdfjs.PasswordException) throw new PdfError('パスワードで保護された PDF は読めません。保護を外してから読み込んでください。');
    if (e instanceof pdfjs.InvalidPDFException) throw new PdfError('PDF として読めませんでした。ファイルが壊れていないか確認してください。');
    throw new PdfError('PDF を読めませんでした。');
  } finally {
    await task.destroy();
  }
}

/** サイドパネルから呼ぶ入口。PDF ごとに Worker を起こし、読み終えたら止めて原文を残さない */
export async function readPdfFile(file: File): Promise<PdfImport> {
  if (!file.name.toLowerCase().endsWith(PDF_EXTENSION)) throw new PdfError('PDF ファイルではありません。');
  if (file.size > MAX_PDF_BYTES) throw new PdfError(`ファイルが大きすぎます（上限 ${MAX_PDF_BYTES / 1024 / 1024}MB）。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfjs = await import('pdfjs-dist');
  const port = new Worker(new URL('../worker/pdf.worker.ts', import.meta.url), { type: 'module' });
  // 型定義では port が null 扱いだが、実装は Worker を受け取る
  const worker = new pdfjs.PDFWorker({ port: port as unknown as null });
  try {
    // CMap は拡張に同梱したもの（wxt.config.ts）を読む。外部には取りに行かない
    return await extractPdfText(pdfjs, bytes, { worker, cMapUrl: new URL('/pdf-cmaps/', location.href).href });
  } finally {
    worker.destroy();
    port.terminate();
  }
}
