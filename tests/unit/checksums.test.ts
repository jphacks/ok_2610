import { describe, expect, test } from 'vitest';
import { luhnValid, myNumberValid } from '../../src/core/detect/checksums';

describe('luhnValid', () => {
  test('テスト用のカード番号は通る', () => {
    expect(luhnValid('4111 1111 1111 1111')).toBe(true);
    expect(luhnValid('5555-5555-5555-4444')).toBe(true);
  });
  test('検査数字が合わない番号・同じ数字の並びは通らない', () => {
    expect(luhnValid('4111 1111 1111 1112')).toBe(false);
    expect(luhnValid('0000000000000000')).toBe(false);
    expect(luhnValid('123456')).toBe(false);
  });
});

describe('myNumberValid', () => {
  test('検査数字が一致する12桁だけ通る', () => {
    expect(myNumberValid('123456789018')).toBe(true);
    expect(myNumberValid('1234 5678 9018')).toBe(true);
    expect(myNumberValid('123456789012')).toBe(false);
  });
});
