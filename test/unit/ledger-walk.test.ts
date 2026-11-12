import { expect, test } from 'bun:test';
import { ledgerIsAWalk } from '../support/invariants';

// The invariant checker is test code that decides pass/fail for most DB tests, so it gets its own negative controls:
// each case below is a ledger that a real bug would produce, and the checker must reject it.
const e = (before: number, after: number) => ({ before: BigInt(before), after: BigInt(after) });

test('a valid ledger is a walk 0 -> Balance, in any listing order', () => {
  const ledger = [e(0, 10000), e(10000, 2000), e(2000, 4000), e(4000, 2000)]; // OPENING 100, BET 80, WIN 20, BET 20
  expect(ledgerIsAWalk(ledger, 2000n)).toBe(true);
  expect(ledgerIsAWalk([...ledger].reverse(), 2000n)).toBe(true);
  expect(ledgerIsAWalk([], 0n)).toBe(true);
});

test('negative controls: the shapes real bugs leave behind are rejected', () => {
  // lost update: two BETs of 80 both read 100; Balance written 20 by the last one, both entries start at 100
  expect(ledgerIsAWalk([e(0, 10000), e(10000, 2000), e(10000, 2000)], 2000n)).toBe(false);
  // Balance moved without an entry
  expect(ledgerIsAWalk([e(0, 10000), e(10000, 2000)], 1000n)).toBe(false);
  // an invented detour that never touches the real path (degrees balance, but it is disconnected)
  expect(ledgerIsAWalk([e(0, 10000), e(10000, 2000), e(5000, 6000), e(6000, 5000)], 2000n)).toBe(false);
  // first entry not starting at 0
  expect(ledgerIsAWalk([e(500, 10500)], 10500n)).toBe(false);
});
