import { expect, test } from 'vitest';
import { alignTokens, chunkText, entitiesToSpans, type NerToken } from '../../src/engines/ner-post';

// Transformers.js の token-classification の出力形（文字位置なし。index は <s> を 0 とする）
const tok = (index: number, word: string, entity: string, score = 0.99): NerToken => ({ index, word, entity, score });

const text = '横浜市在住の田中花子です。株式会社ABCソリューションズ 御中';
const tokens = [
  tok(1, '▁', 'O'),
  tok(2, '横浜', 'LOC'),
  tok(3, '市', 'LOC'),
  tok(4, '在', 'O'),
  tok(5, '住', 'O'),
  tok(6, 'の', 'O'),
  tok(7, '田', 'PER'),
  tok(8, '中', 'PER'),
  tok(9, '花', 'PER'),
  tok(10, '子', 'PER'),
  tok(11, 'です', 'O'),
  tok(12, '。', 'O'),
  tok(13, '株式会社', 'ORG'),
  tok(14, 'ABC', 'ORG'),
  tok(15, 'ソ', 'ORG'),
  tok(16, 'リュ', 'ORG'),
  tok(17, 'ーション', 'ORG'),
  tok(18, 'ズ', 'ORG'),
  tok(19, '▁御', 'PER'),
  tok(20, '中', 'PER'),
];

test('トークンを原文に突き合わせ、同じラベルの連続を1つの固有表現にする', () => {
  const spans = entitiesToSpans(text, tokens);
  expect(spans.map((s) => [s.category, text.slice(s.start, s.end)])).toEqual([
    ['place', '横浜市'],
    ['personName', '田中花子'],
    ['orgName', '株式会社ABCソリューションズ'],
  ]);
});

test('「御中」のような語は人名にしない', () => {
  expect(entitiesToSpans(text, tokens).some((s) => text.slice(s.start, s.end) === '御中')).toBe(false);
});

test('全角英数は NFKC で突き合わせ、原文の位置を返す', () => {
  const t = 'ＡＢＣ商事';
  const aligned = alignTokens(t, [tok(1, 'ABC', 'ORG'), tok(2, '商事', 'ORG')]);
  expect(aligned.map((a) => t.slice(a.start, a.end))).toEqual(['ＡＢＣ', '商事']);
});

test('確信度が低い固有表現と、敬称・助詞は外す', () => {
  const t = '佐藤さんが来た';
  expect(entitiesToSpans(t, [tok(1, '佐藤', 'PER'), tok(2, 'さん', 'PER'), tok(3, 'が', 'O')]).map((s) => t.slice(s.start, s.end))).toEqual(['佐藤']);
  expect(entitiesToSpans(t, [tok(1, '佐藤', 'PER', 0.3)])).toEqual([]);
});

test('文の区切りで分割し、位置を保つ', () => {
  const long = `${'あ'.repeat(200)}。${'い'.repeat(200)}。`;
  const chunks = chunkText(long, 300);
  expect(chunks.map((c) => c.text).join('')).toBe(long);
  expect(chunks[1]?.offset).toBe(201);
});
