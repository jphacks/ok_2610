import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { extractPdfText, joinPages, MAX_PDF_PAGES, pageItemsToText, PdfError, readPdfFile } from '../../src/infra/pdf';
import { run } from './helpers';
import { buildPdf } from './pdf-fixture';

const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(pdfjsRoot, 'legacy/build/pdf.worker.mjs')).href;
// Node では CMap をファイルから読む。末尾の区切りが要る
const cMapUrl = join(pdfjsRoot, 'cmaps') + '/';
const lib = pdfjs as unknown as typeof import('pdfjs-dist');

describe('pageItemsToText', () => {
  it('hasEOL で改行し、行末の空白と3行以上の空行を詰める', () => {
    expect(
      pageItemsToText([
        { str: '件名：', hasEOL: false },
        { str: '面談記録 ', hasEOL: true },
        { str: '', hasEOL: true },
        { str: '', hasEOL: true },
        { str: '', hasEOL: true },
        { str: '担当：佐藤', hasEOL: false },
      ]),
    ).toBe('件名：面談記録\n\n担当：佐藤');
  });
});

describe('joinPages', () => {
  it('ページごとに見出しを付け、文字のないページを知らせる', () => {
    const r = joinPages(['一枚目', '', '三枚目'], 3);
    expect(r.text).toBe('【ページ 1】\n一枚目\n\n【ページ 3】\n三枚目');
    expect(r.notes.join('\n')).toContain('文字のないページがあります（2 ページ）');
    expect(r.notes.join('\n')).toContain('画像の中の文字・注釈');
  });

  it('どのページにも文字がなければ、読めないと伝える', () => {
    expect(() => joinPages(['', ''], 2)).toThrow(PdfError);
  });

  it('上限より先のページは検査していないと伝える', () => {
    const r = joinPages(['あ'], 5);
    expect(r.notes.join('\n')).toContain('2 ページ以降（全 5 ページ）は検査していません');
  });
});

describe('extractPdfText', () => {
  it('英数字と日本語の文字を、ページの見出し付きで取り出す', async () => {
    const bytes = buildPdf([['Tel: 090-1234-5678', '担当は田中花子です'], [], ['青葉社の東支店']]);
    const r = await extractPdfText(lib, bytes, { cMapUrl });
    expect(r.pageCount).toBe(3);
    expect(r.text).toBe('【ページ 1】\nTel: 090-1234-5678\n担当は田中花子です\n\n【ページ 3】\n青葉社の東支店');
    expect(r.notes.join('\n')).toContain('文字のないページがあります（2 ページ）');
  });

  it('取り出した文章から電話番号と氏名が検出される', async () => {
    const r = await extractPdfText(lib, buildPdf([['Tel: 090-1234-5678', '担当は田中花子さんです']]), { cMapUrl });
    const cats = (await run(r.text)).candidates.flatMap((c) => c.categories);
    expect(cats).toContain('phone');
  });

  it('上限を超えるページは読まない', async () => {
    const bytes = buildPdf(Array.from({ length: MAX_PDF_PAGES + 2 }, (_, i) => [`page ${i + 1}`]));
    const r = await extractPdfText(lib, bytes, { cMapUrl });
    expect(r.text).toContain(`page ${MAX_PDF_PAGES}`);
    expect(r.text).not.toContain(`page ${MAX_PDF_PAGES + 1}`);
    expect(r.notes.join('\n')).toContain(`全 ${MAX_PDF_PAGES + 2} ページ`);
  });

  it('文字のない PDF は読めないと伝える', async () => {
    await expect(extractPdfText(lib, buildPdf([[], []]), { cMapUrl })).rejects.toThrow(/スキャンした画像だけの PDF/);
  });

  it('PDF でないものは壊れていると伝える', async () => {
    await expect(extractPdfText(lib, new TextEncoder().encode('これは PDF ではない'), { cMapUrl })).rejects.toThrow(PdfError);
  });
});

describe('readPdfFile', () => {
  it('拡張子と大きさを先に確かめる', async () => {
    await expect(readPdfFile(new File(['x'], 'memo.txt'))).rejects.toThrow('PDF ファイルではありません');
    const big = { name: 'big.pdf', size: 21 * 1024 * 1024 } as File;
    await expect(readPdfFile(big)).rejects.toThrow('ファイルが大きすぎます');
  });
});
