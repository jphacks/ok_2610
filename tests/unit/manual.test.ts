import { describe, expect, it } from 'vitest';
import { countOccurrences, manualMaskOps } from '../../src/core/manual';

const text = '山田さんと山田部長は、山田工業の山田と会った。';
const c = (start: number, end: number, output: string) => ({ start, end, text: text.slice(start, end), output });

describe('manualMaskOps', () => {
  it('同じ語をすべて追加する', () => {
    const ops = manualMaskOps(text, '山田', 'personName', [], { all: true });
    expect(ops.map((o) => o.kind === 'add' && o.start)).toEqual([0, 5, 11, 16]);
    expect(countOccurrences(text, '山田')).toBe(4);
  });

  it('すでに加工した候補と重なる箇所は除くが、選んだ範囲は必ず含める', () => {
    const company = c(11, 15, '組織A');
    const ops = manualMaskOps(text, '山田', 'personName', [company, c(5, 7, '山田')], { all: true, anchor: { start: 11, end: 13 } });
    // 11 は選んだ範囲なので含み、残した候補（5）は上書きする
    expect(ops.map((o) => o.kind === 'add' && o.start)).toEqual([0, 5, 11, 16]);
    const ops2 = manualMaskOps(text, '山田', 'personName', [company], { all: true });
    expect(ops2.map((o) => o.kind === 'add' && o.start)).toEqual([0, 5, 16]);
  });

  it('すべてにしないときは選んだ範囲だけ、範囲がなければ最初の1箇所', () => {
    expect(manualMaskOps(text, '山田', 'custom', [], { all: false, anchor: { start: 16, end: 18 } })).toEqual([{ kind: 'add', start: 16, end: 18, category: 'custom' }]);
    expect(manualMaskOps(text, '山田', 'custom', [], { all: false })).toEqual([{ kind: 'add', start: 0, end: 2, category: 'custom' }]);
  });

  it('選んだ範囲と入力した語が食い違えば、語で探す', () => {
    const ops = manualMaskOps(text, '部長', 'position', [], { all: false, anchor: { start: 0, end: 2 } });
    expect(ops).toEqual([{ kind: 'add', start: 7, end: 9, category: 'position' }]);
  });

  it('見つからなければ何もしない', () => {
    expect(manualMaskOps(text, '鈴木', 'custom', [], { all: true })).toEqual([]);
  });
});
