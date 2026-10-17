import { expect, test } from 'vitest';
import { answerToSpans, parseNanoAnswer } from '../../src/engines/nano-parse';

test('前後に余計な文字があっても JSON 部分を読む。壊れていれば null', () => {
  expect(parseNanoAnswer('結果: {"persons":["田中"],"organizations":[],"places":[],"dates":[]} 以上')?.persons).toEqual(['田中']);
  expect(parseNanoAnswer('{"persons": [')).toBeNull();
  expect(parseNanoAnswer('説明だけ')).toBeNull();
});

test('抽出語を原文に突き合わせ、原文にない語（言い換え・幻覚）は捨てる', () => {
  const text = '田中が10月3日に来店。田中は常連。';
  const spans = answerToSpans(text, {
    persons: ['田中', '鈴木'],
    organizations: [],
    places: [],
    dates: [{ text: '10月3日', role: 'business' }],
  });
  expect(spans.filter((s) => s.category === 'personName').map((s) => s.start)).toEqual([0, 12]);
  expect(spans.find((s) => s.category === 'date')).toMatchObject({ start: 3, end: 8, role: 'businessDate', source: 'nano' });
});
