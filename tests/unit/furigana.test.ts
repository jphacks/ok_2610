import { describe, expect, test } from 'vitest';
import { detectRules } from '../../src/core/detect/rules';
import type { EngineOutput } from '../../src/core/analyze';
import { TIER } from '../../src/core/model/types';
import { run, settings } from './helpers';

function names(text: string): string[] {
  const spans = detectRules(text).filter((s) => s.category === 'personName');
  const unique = [...new Map(spans.map((s) => [`${s.start}:${s.end}`, s])).values()].sort((a, b) => a.start - b.start);
  return unique.map((s) => text.slice(s.start, s.end));
}

/** 人名の候補と、その人物ラベル */
async function people(text: string, labelsOnly = true) {
  const r = await run(text, { settings: settings({ labelsOnly }) });
  const label = new Map(r.entities.map((e) => [e.id, e.label]));
  return {
    result: r,
    found: r.candidates.filter((c) => c.categories.includes('personName')).map((c) => [c.text, c.entityId ? label.get(c.entityId) : undefined]),
  };
}

describe('ふりがな（読み仮名）', () => {
  test('見出しの後ろの読み（空白・コロン・タブ・次の行）', () => {
    expect(names('ふりがな　やまだ　たろう')).toEqual(['やまだ　たろう']);
    expect(names('フリガナ：ヤマダ タロウ')).toEqual(['ヤマダ タロウ']);
    expect(names('ふりがな\tやまだ たろう')).toEqual(['やまだ たろう']);
    expect(names('氏名（フリガナ）\nヤマダ　タロウ')).toEqual(['ヤマダ　タロウ']);
    expect(names('ﾌﾘｶﾞﾅ ﾔﾏﾀﾞ ﾀﾛｳ')).toEqual(['ﾔﾏﾀﾞ ﾀﾛｳ']);
  });

  test('文の中の「ふりがな」は拾わない', () => {
    expect(names('漢字にはふりがなをふってください')).toEqual([]);
    expect(names('ふりがなつきの資料')).toEqual([]);
    expect(names('フリガナ は不要です')).toEqual([]);
  });

  test('表の「フリガナ」列の値', () => {
    const t = '氏名\tフリガナ\t電話\n山田太郎\tヤマダタロウ\t090-1111-2222\n佐藤花子\tサトウハナコ\t090-3333-4444';
    expect(names(t)).toEqual(expect.arrayContaining(['ヤマダタロウ', 'サトウハナコ']));
  });

  test('欄の形の氏名（区切りが空白だけ）', () => {
    expect(names('氏名　山田　太郎\n')).toEqual(['山田　太郎']);
    expect(names('名前 を入力してください')).toEqual([]);
  });

  test('履歴書: 読みと氏名を同じ人物にする', async () => {
    const { found, result } = await people('ふりがな　やまだ　たろう\n氏名　山田　太郎\n');
    expect(found).toEqual([
      ['やまだ　たろう', '人物A'],
      ['山田　太郎', '人物A'],
    ]);
    expect(result.masked).not.toMatch(/やまだ|山田/u);
    // 復元では漢字の氏名に戻す
    expect(result.restoreMap['人物A']).toBe('山田　太郎');
  });

  test('表: 同じ行の氏名と同じ人物にする', async () => {
    const { found } = await people('氏名\tフリガナ\n山田太郎\tヤマダタロウ\n佐藤花子\tサトウハナコ\n');
    expect(found).toEqual([
      ['山田太郎', '人物A'],
      ['ヤマダタロウ', '人物A'],
      ['佐藤花子', '人物B'],
      ['サトウハナコ', '人物B'],
    ]);
  });

  test('氏名のすぐ上の行の読み（PDF・画像のルビ。氏名は NER が拾う）', async () => {
    const text = 'やまだ　たろう\n山田　太郎\n';
    const at = text.indexOf('山田');
    const ner: EngineOutput = {
      engine: 'ner',
      status: 'ok',
      ms: 0,
      spans: [{ start: at, end: at + 5, category: 'personName', source: 'ner', certainty: '推定', evidence: [{ kind: 'model', detail: 'NER' }], tier: TIER.ner }],
    };
    const r = await run(text, { settings: settings({ labelsOnly: true, profile: ['rule', 'ner'] }), engineOutputs: [ner] });
    const label = new Map(r.entities.map((e) => [e.id, e.label]));
    const found = r.candidates.filter((c) => c.categories.includes('personName')).map((c) => [c.text, c.entityId ? label.get(c.entityId) : undefined]);
    expect(found).toEqual([
      ['やまだ　たろう', '人物A'],
      ['山田　太郎', '人物A'],
    ]);
  });

  test('NER が読みも人名として拾ったときも、氏名と同じ人物にする（見出しが線画で文字にならない PDF）', async () => {
    const text = 'やまぐち はなこ\n山口 花子\n';
    const span = (start: number, end: number) => ({ start, end, category: 'personName' as const, source: 'ner' as const, certainty: '推定' as const, evidence: [{ kind: 'model' as const, detail: 'NER' }], tier: TIER.ner });
    const at = text.indexOf('山口');
    const ner: EngineOutput = { engine: 'ner', status: 'ok', ms: 0, spans: [span(0, 8), span(at, at + 5)] };
    const r = await run(text, { settings: settings({ labelsOnly: true, profile: ['rule', 'ner'] }), engineOutputs: [ner] });
    const label = new Map(r.entities.map((e) => [e.id, e.label]));
    expect(r.candidates.filter((c) => c.categories.includes('personName')).map((c) => [c.text, c.entityId ? label.get(c.entityId) : undefined])).toEqual([
      ['やまぐち はなこ', '人物A'],
      ['山口 花子', '人物A'],
    ]);
  });

  test('住所のすぐ上の読み（郵便番号の行をはさんでも）を住所として隠す', async () => {
    const r = await run('ほっかいどう さっぽろし ちゅうおうく\n0600001\n北海道札幌市中央区北一条西2-1 コーポ北101号室\n');
    expect(r.masked).not.toMatch(/ほっかいどう|さっぽろ|0600001|北一条/u);
    expect(r.candidates.find((c) => c.text.startsWith('ほっかいどう'))?.categories).toContain('address');
    // 文の途中の地名の上の行は読みにしない
    const r2 = await run('ありがとうございます\n昨日は北海道に行きました\n');
    expect(r2.candidates.map((c) => c.text)).not.toContain('ありがとうございます');
  });

  test('氏名の直後の括弧の読み', async () => {
    const { found } = await people('氏名：山田太郎（やまだ たろう）\n');
    expect(found.map((f) => f[1])).toEqual(found.map(() => '人物A'));
    expect(found.map((f) => f[0]).join('|')).toMatch(/やまだ たろう/u);
  });

  test('氏名の上の行でも、文は読みにしない', async () => {
    const { found } = await people('こんにちは\n氏名　山田太郎\n');
    expect(found.map((f) => f[0])).toEqual(['山田太郎']);
  });
});

describe('ふりがな: 見出しの語を名前と取り違えない', () => {
  test('「名前\tメール」「氏名\t住所」の見出しの行', () => {
    expect(names('名前\tメール\n')).toEqual([]);
    expect(names('氏名\t住所\t電話番号\n')).toEqual([]);
  });
});

describe('ふりがな: PDF のまま加工する', () => {
  test('履歴書の「ふりがな」の欄も、氏名と同じラベルで隠れる', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const { JP_FONT, textOnlyEnv } = await import('./pdf-env');
    const { importPdf, loadEditable } = await import('../../src/infra/pdf/document');
    const { exportMaskedPdf } = await import('../../src/infra/pdf/mask');
    const { buildTextModel, pageText } = await import('../../src/infra/pdf/textmodel');

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const jp = await doc.embedFont(JP_FONT, { subset: true });
    const page = doc.addPage([595, 842]);
    page.drawText('履歴書', { x: 50, y: 790, size: 18, font: jp });
    page.drawText('ふりがな　やまだ　たろう', { x: 50, y: 750, size: 9, font: jp });
    page.drawText('氏名　山田　太郎', { x: 50, y: 725, size: 16, font: jp });
    const src = await importPdf('履歴書.pdf', await doc.save(), null);
    expect(src.text).toContain('やまだ');

    const result = await run(src.text, { settings: settings({ labelsOnly: true }) });
    const out = await exportMaskedPdf(src, result.segments, textOnlyEnv);
    const model = buildTextModel(await loadEditable(out.bytes));
    const text = pageText(model.glyphs, model.glyphs.map((_, i) => i)).text;
    expect(text).not.toMatch(/やまだ|たろう|山田|太郎/u);
    expect(text.match(/人物A/gu)?.length).toBe(2);
  });
});
