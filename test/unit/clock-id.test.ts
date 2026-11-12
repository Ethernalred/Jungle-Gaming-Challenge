import { expect, test } from 'bun:test';
import { SystemClock } from '../../src/domain/clock';
import { UuidV7Generator } from '../../src/domain/id-generator';

test('SystemClock returns the current time', () => {
  expect(Math.abs(new SystemClock().now().getTime() - Date.now())).toBeLessThan(1000);
});

test('UuidV7Generator yields unique, time-ordered v7 ids', () => {
  const g = new UuidV7Generator();
  const a = g.next();
  const b = g.next();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
  expect([a, b].sort()[0]).toBe(a);
});
