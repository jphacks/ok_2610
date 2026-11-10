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
    // 「花」「子」は名前にしか出てこない。本文のフォントは書き直さず、その字形と対応だけを取り除く
    const notes = out.notes.join(' / ');
    expect(notes).toContain('字形を');
    expect(notes).not.toContain('同梱フォントで書き直しました');
    const model = buildTextModel(doc);
    expect(model.glyphs.some((g) => g.unicode === '花')).toBe(false);
    const { parseCMap } = await import('../../src/infra/pdf/cmap');
    const { streamBytes } = await import('../../src/infra/pdf/objects');
    const { PDFStream, PDFName } = await import('pdf-lib');
    let toUnicodes = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFStream) || obj.dict.get(PDFName.of('Subtype')) || obj.dict.get(PDFName.of('Length1'))) continue;
      const bytes = streamBytes(obj);
      const head = new TextDecoder('latin1').decode(bytes);
      if (!head.includes('beginbfchar') && !head.includes('beginbfrange')) continue;
      toUnicodes++;
      const mapped = [...parseCMap(bytes).unicode.values()].join('');
      expect(mapped).not.toContain('花');
      // 隠していない文字の対応は残る
      if (mapped.includes('面')) expect(mapped).toContain('担当');
    }
    expect(toUnicodes).toBeGreaterThan(0);
  });

  it('TrueType から指定した字形の輪郭だけを空にする', async () => {
    const { blankTrueTypeGlyphs } = await import('../../src/infra/pdf/fontscrub');
    const original = fontkit.create(JP_FONT);
    const gidHana = original.glyphForCodePoint('花'.codePointAt(0)!).id;
    const gidChu = original.glyphForCodePoint('中'.codePointAt(0)!).id;
    const out = blankTrueTypeGlyphs(new Uint8Array(JP_FONT), new Set([gidHana]));
    const f = fontkit.create(out);
    expect((f.getGlyph(gidHana).path as unknown as { commands: unknown[] }).commands.length).toBe(0);
    expect((f.getGlyph(gidChu).path as unknown as { commands: unknown[] }).commands.length).toBeGreaterThan(0);
    expect(f.getGlyph(gidChu).advanceWidth).toBe(original.getGlyph(gidChu).advanceWidth);
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
    // 元の PDF が手元にないときは同梱のフォントで書き、そのことを伝える
    expect(back.notes.join(' ')).toContain('同梱のゴシック体');
  });

  it('元の PDF があれば、元のフォント・大きさ・1文字ずつの位置のまま書き戻す', async () => {
    const { restorePdf } = await import('../../src/infra/pdf/restore');
    const src = await importPdf('面談.pdf', await samplePdf(), null);
    const result = await run(src.text);
    const masked = await exportMaskedPdf(src, result.segments, env);
    const back = await restorePdf(
      { fileName: masked.fileName, bytes: masked.bytes, restoreMap: result.restoreMap, generalizedMap: result.generalizedMap, original: { base: src.base, maskedImages: [] } },
      env,
    );
    expect(back.notes).toEqual([]);
    expect(back.replaced).toBeGreaterThanOrEqual(4);
    const before = buildTextModel(await loadEditable(src.base));
    const after = buildTextModel(await loadEditable(back.bytes));
    expect(textOf(after).replace(/\s/g, '')).toBe(textOf(before).replace(/\s/g, ''));
    // 書き戻した文字は、元と同じ字形・大きさで、元と同じ位置にある
    for (const word of ['田中花子', '090-1234-5678', 'sato@example.com']) {
      const at = (m: typeof before) => {
        const { text, map } = pageText(m.glyphs, m.glyphs.map((_, i) => i));
        const i = text.indexOf(word);
        return [...new Set(Array.from({ length: word.length }, (_, k) => map[i + k]!).filter((v) => v >= 0))].map((v) => m.glyphs[v]!);
      };
      const a = at(before);
      const b = at(after);
      expect(b.length, word).toBe(a.length);
      b.forEach((g, k) => {
        expect(Math.abs(g.x - a[k]!.x), word).toBeLessThan(0.01);
        expect(Math.abs(g.y - a[k]!.y), word).toBeLessThan(0.01);
        expect(g.state.size, word).toBe(a[k]!.state.size);
        expect(g.state.font?.baseFont, word).toBe(a[k]!.state.font?.baseFont);
        expect(g.state.fontName?.startsWith('TCLabel'), word).toBe(false);
      });
    }
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

describe('書き込み用のフォント', () => {
  it('埋め込んだラベル用フォントの字形が壊れていない', async () => {
    const { embedLabelFont } = await import('../../src/infra/pdf/mask');
    const { streamBytes } = await import('../../src/infra/pdf/objects');
    const { PDFDict, PDFName } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const text = '[日付1][住所1]組織A人物B[電話番号1]';
    const font = await embedLabelFont(doc, new Uint8Array(JP_FONT), [text]);
    doc.addPage().drawText(text, { font, size: 12, x: 10, y: 10 });
    const saved = await PDFDocument.load(await doc.save());
    const full = fontkit.create(JP_FONT);
    let checked = 0;
    for (const [, obj] of saved.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict) || String(obj.get(PDFName.of('Subtype'))) !== '/CIDFontType2') continue;
      const fd = saved.context.lookup(obj.get(PDFName.of('FontDescriptor'))) as typeof obj;
      const ff = saved.context.lookup(fd.get(PDFName.of('FontFile2'))) as unknown as { dict: typeof obj } & Parameters<typeof streamBytes>[0];
      const embedded = fontkit.create(Buffer.from(streamBytes(ff)) as never);
      for (const ch of new Set(text)) {
        const gid = full.glyphForCodePoint(ch.codePointAt(0)!).id;
        const want = (full.getGlyph(gid).path as unknown as { commands: unknown[] }).commands.length;
        expect((embedded.getGlyph(gid).path as unknown as { commands: unknown[] }).commands.length, ch).toBe(want);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
