import { expect, test } from 'bun:test';
import { backoffMs } from '../../src/domain/outbox';

test('backoff is 1 s x 2^n capped at 5 min, with no attempt limit (D24)', () => {
  expect([0, 1, 2, 3].map((n) => backoffMs(n))).toEqual([1000, 2000, 4000, 8000]);
  expect(backoffMs(9)).toBe(300_000);
  expect(backoffMs(100_000)).toBe(300_000);
});
