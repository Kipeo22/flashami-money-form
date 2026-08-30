import { describe, expect, it } from 'vitest';

import { parseAmountYen } from './amount.js';

describe('parseAmountYen', () => {
  it.each([
    ['12,500円', 12_500],
    ['￥１２５００', 12_500],
    [' 12500 ', 12_500],
  ])('parses %s', (input, expected) => {
    expect(parseAmountYen(input)).toBe(expected);
  });

  it.each(['0', '-1', '12.5', 'abc', '1000000001'])('rejects %s', (input) => {
    expect(() => parseAmountYen(input)).toThrow();
  });
});
