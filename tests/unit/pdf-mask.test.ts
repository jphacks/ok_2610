import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { importPdf } from '../../src/infra/pdf/document';
import { exportMaskedPdf } from '../../src/infra/pdf/mask';
import { buildTextModel, pageText } from '../../src/infra/pdf/textmodel';
import { loadEditable } from '../../src/infra/pdf/document';
import { run } from './helpers';

const require = createRequire(import.meta.url);
export const JP_FONT = readFileSync(require.resolve('@expo-google-fonts/biz-udpgothic/400Regular/BIZUDPGothic_400Regular.ttf'));
const env = { labelFont: async () => new Uint8Array(JP_FONT), images: null };

export async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const jp = await doc.embedFont(JP_FONT, { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('面談記録（中央支店）', { x: 50, y: 780, size: 16, font: jp });
  page.drawText('担当は田中花子さんです。電話 090-1234-5678', { x: 50, y: 740, size: 12, font: jp });
  page.drawText('Contact: sato@example.com for details', { x: 50, y: 710, size: 12, font: helv });
  page.drawText('次回は中央支店で行います。', { x: 50, y: 680, size: 12, font: jp });
  const p2 = doc.addPage([595, 842]);
  p2.drawText('二枚目も田中花子さんの件です。', { x: 50, y: 780, size: 12, font: jp });
  doc.setTitle('田中花子 面談');
  doc.setAuthor('田中花子');
  return doc.save();
}

function textOf(model: ReturnType<typeof buildTextModel>) {
  return pageText(model.glyphs, model.glyphs.map((_, i) => i)).text;
}

/** 文字列の最初の文字の位置 */
function positionOf(model: ReturnType<typeof buildTextModel>, needle: string) {
  const { text, map } = pageText(model.glyphs, model.glyphs.map((_, i) => i));
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const g = model.glyphs[map[at]!]!;
  return { x: g.x, y: g.y, page: g.page };
}

describe('PDF のまま加工する', () => {
  it('取り込むと、ページ見出し付きの文章と、文字の出どころの対応ができる', async () => {
    const src = await importPdf('面談.pdf', await samplePdf(), null);
    expect(src.text).toContain('【ページ 1】\n面談記録（中央支店）\n担当は田中花子さんです。電話 090-1234-5678\nContact: sato@example.com for details');
    expect(src.text).toContain('【ページ 2】\n二枚目も田中花子さんの件です。');
    expect(src.blockers).toEqual([]);
    expect(src.charMap.length).toBe(src.text.length);
  });

  it('隠す語をラベルに置き換え、ほかの文字の位置は変えない', async () => {
    const src = await importPdf('面談.pdf', await samplePdf(), null);
    const result = await run(src.text);
    const labels = result.segments.filter((s) => s.kind === 'changed');
    expect(labels.map((s) => s.kind === 'changed' && s.original)).toEqual(expect.arrayContaining(['田中花子', '090-1234-5678']));

    const out = await exportMaskedPdf(src, result.segments, env);
    expect(out.fileName).toBe('面談_加工済み.pdf');
    const after = buildTextModel(await loadEditable(out.bytes));
    const before = buildTextModel(await loadEditable(src.base));
    const text = textOf(after);
    expect(text).not.toContain('田中花子');
    expect(text).not.toContain('090-1234-5678');
    expect(text).not.toContain('sato@example.com');
    for (const s of labels) if (s.kind === 'changed') expect(text).toContain(s.text);

    // 行の始まりと、置き換えた語の直後の文字の位置は同じ（書き直したフォントの文字は、行の中で字の形と幅が少し変わる）
    for (const needle of ['面談記録', 'Contact:', ' for details', '次回は', 'さんです。電話', '二枚目も']) {
      const a = positionOf(before, needle);
      const b = positionOf(after, needle);
      expect(b, needle).not.toBeNull();
      expect(Math.abs(a!.x - b!.x), needle).toBeLessThan(0.01);
      expect(Math.abs(a!.y - b!.y), needle).toBeLessThan(0.01);
    }
  });

  it('ファイル情報や、隠した語にしか使われない字形を残さない', async () => {
    const src = await importPdf('面談.pdf', await samplePdf(), null);
    const result = await run(src.text);
    const out = await exportMaskedPdf(src, result.segments, env);
    const doc = await PDFDocument.load(out.bytes, { updateMetadata: false });
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
    // 「花」は名前にしか出てこない。元のフォントは外され、ラベル用のフォントにも「花」は入らない
    expect(out.notes.join('\n')).toContain('フォントの文字を同梱フォントで書き直しました');
    const model = buildTextModel(doc);
    expect(model.glyphs.some((g) => g.unicode === '花')).toBe(false);
  });
});

describe('PDF のまま元に戻す', () => {
  it('ラベルを元の語に戻し、行の始まりの位置は変えない', async () => {
    const { restorePdf } = await import('../../src/infra/pdf/restore');
    const src = await importPdf('面談.pdf', await samplePdf(), null);
    const result = await run(src.text);
    const masked = await exportMaskedPdf(src, result.segments, env);
    const back = await restorePdf({ fileName: masked.fileName, bytes: masked.bytes, restoreMap: result.restoreMap, generalizedMap: result.generalizedMap }, env);
    expect(back.fileName).toBe('面談_復元済み.pdf');
    const after = buildTextModel(await loadEditable(back.bytes));
    const text = textOf(after);
    expect(text).toContain('田中花子');
    expect(text).toContain('090-1234-5678');
    expect(text).toContain('sato@example.com');
    expect(back.replaced).toBeGreaterThanOrEqual(4);
    const before = buildTextModel(await loadEditable(src.base));
    for (const needle of ['面談記録', 'Contact:', '次回は', '二枚目も']) {
      const a = positionOf(before, needle)!;
      const b = positionOf(after, needle)!;
      expect(Math.abs(a.x - b.x), needle).toBeLessThan(0.01);
      expect(Math.abs(a.y - b.y), needle).toBeLessThan(0.01);
    }
    // 元の語は、ラベルがあった場所から始まる
    const nameBefore = positionOf(before, '田中花子')!;
    const nameAfter = positionOf(after, '田中花子')!;
    expect(Math.abs(nameBefore.x - nameAfter.x)).toBeLessThan(0.01);
  });
});

describe('PDF のときはラベルだけで隠す', () => {
  it('一般化・削除の代わりにラベルにし、すべて対応表で元に戻せる', async () => {
    const { settings } = await import('./helpers');
    const text = '営業部の担当は田中花子さん（35歳）です。住所は東京都港区芝公園4-2-8です。';
    const normal = await run(text);
    const labels = await run(text, { settings: settings({ labelsOnly: true }) });
    const changedNormal = normal.segments.filter((s) => s.kind === 'changed');
    const changed = labels.segments.filter((s) => s.kind === 'changed');
    expect(changed.length).toBe(changedNormal.length);
    expect(changedNormal.some((s) => !(s.text in normal.restoreMap))).toBe(true);
    for (const s of changed) expect(labels.restoreMap[s.text], s.text).toBe(s.kind === 'changed' ? s.original : '');
  });
});

describe('AIが作った PDF を元に戻す', () => {
  it('別のレイアウトの PDF でも、ラベルをその場所で元の語に書き換える', async () => {
    const { restorePdf } = await import('../../src/infra/pdf/restore');
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const jp = await doc.embedFont(JP_FONT, { subset: true });
    const page = doc.addPage([400, 300]);
    page.drawText('要約: 人物Aは[電話番号1]で連絡可能。', { x: 30, y: 250, size: 11, font: jp });
    page.drawText('人物ABという別の語は戻さない。', { x: 30, y: 220, size: 11, font: jp });
    const bytes = await doc.save();
    const back = await restorePdf(
      { fileName: '回答.pdf', bytes, restoreMap: { 人物A: '田中花子', '[電話番号1]': '090-1234-5678' }, generalizedMap: {} },
      { labelFont: async () => new Uint8Array(JP_FONT), images: null },
    );
    expect(back.fileName).toBe('回答_復元済み.pdf');
    expect(back.replaced).toBe(2);
    const text = textOf(buildTextModel(await loadEditable(back.bytes)));
    expect(text).toContain('要約: 田中花子は090-1234-5678で連絡可能。');
    expect(text).toContain('人物ABという別の語は戻さない。');
  });
});

describe('埋め込みなしの日本語フォント（既定の CMap）', () => {
  it('UniJIS-UCS2-H の文字も読め、ラベルに置き換えられる', async () => {
    const { buildPdf } = await import('./pdf-fixture');
    const src = await importPdf('古い.pdf', buildPdf([['Tel: 090-1234-5678', '担当は田中花子さんです'], []]), null);
    expect(src.text).toBe('【ページ 1】\nTel: 090-1234-5678\n担当は田中花子さんです\n\n【ページ 2】\n');
    expect(src.blockers).toEqual([]);
    const result = await run(src.text);
    const out = await exportMaskedPdf(src, result.segments, env);
    const text = textOf(buildTextModel(await loadEditable(out.bytes)));
    expect(text).not.toContain('090-1234-5678');
    expect(text).not.toContain('田中花子');
  });
});
