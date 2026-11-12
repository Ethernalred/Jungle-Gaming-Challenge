import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { ledgerDirectionFor, referenceViolation } from '../../src/domain/reference-rules';

const at = new Date('2026-01-01T00:00:00Z');
const m = (a: string, c = 'BRL') => Money.from({ amount: a, currency: c });
const mk = (o: Record<string, unknown>) => WagerTransaction.create({
  id: 'i', idempotencyKey: 'k', providerId: 'p', externalTransactionId: 'e', playerId: 'pl', walletId: 'w',
  roundId: 'r', gameId: 'g', kind: 'BET', money: m('10.00'), at, referenceExternalTransactionId: 'x', ...o,
} as any);
const bet = mk({ externalTransactionId: 'bet' });
const rev = (kind: string, o: Record<string, unknown> = {}) => mk({ kind, referenceExternalTransactionId: 'bet', ...o });

test('valid Reference combinations pass (REFUND->BET, ROLLBACK->BET/WIN/REFUND, WIN->BET)', () => {
  expect(referenceViolation(rev('REFUND'), bet)).toBeNull();
  expect(referenceViolation(rev('ROLLBACK'), bet)).toBeNull();
  expect(referenceViolation(rev('ROLLBACK'), mk({ kind: 'WIN' }))).toBeNull();
  expect(referenceViolation(rev('ROLLBACK'), mk({ kind: 'REFUND' }))).toBeNull();
  expect(referenceViolation(rev('WIN'), bet)).toBeNull();
});

test('Kind rules: REFUND and WIN only reference a BET; nobody references LOSS/OPENING-like Kinds', () => {
  for (const k of ['WIN', 'REFUND', 'ROLLBACK', 'LOSS']) expect(referenceViolation(rev('REFUND'), mk({ kind: k }))).toBe('INVALID_REFERENCE_KIND');
  expect(referenceViolation(rev('WIN'), mk({ kind: 'WIN' }))).toBe('INVALID_REFERENCE_KIND');
  expect(referenceViolation(rev('ROLLBACK'), mk({ kind: 'ROLLBACK' }))).toBe('INVALID_REFERENCE_KIND');
  expect(referenceViolation(rev('ROLLBACK'), mk({ kind: 'LOSS' }))).toBe('INVALID_REFERENCE_KIND');
});

test('Reference must match provider, player, wallet, currency and Round -> REFERENCE_MISMATCH (checked before Kind and amount)', () => {
  for (const o of [{ providerId: 'q' }, { playerId: 'x' }, { walletId: 'x' }, { roundId: 'x' }, { money: m('10.00', 'USD') }]) {
    expect(referenceViolation(rev('REFUND', o), bet)).toBe('REFERENCE_MISMATCH');
  }
  expect(referenceViolation(rev('REFUND', { roundId: 'x' }), mk({ kind: 'WIN' }))).toBe('REFERENCE_MISMATCH');
});

test('REFUND/ROLLBACK amount must equal the Reference -> AMOUNT_MISMATCH; a WIN is a payout and may differ (F5)', () => {
  expect(referenceViolation(rev('REFUND', { money: m('9.99') }), bet)).toBe('AMOUNT_MISMATCH');
  expect(referenceViolation(rev('ROLLBACK', { money: m('9.99') }), bet)).toBe('AMOUNT_MISMATCH');
  expect(referenceViolation(rev('ROLLBACK', { money: m('9.99') }), mk({ kind: 'WIN', money: m('20.00') }))).toBe('AMOUNT_MISMATCH');
  expect(referenceViolation(rev('WIN', { money: m('20.00') }), bet)).toBeNull();
});

test('ledgerDirectionFor: REFUND credits; ROLLBACK is the opposite of its Reference', () => {
  expect(ledgerDirectionFor('REFUND')).toBe('CREDIT');
  expect(ledgerDirectionFor('ROLLBACK', 'BET')).toBe('CREDIT');
  expect(ledgerDirectionFor('ROLLBACK', 'WIN')).toBe('DEBIT');
  expect(ledgerDirectionFor('ROLLBACK', 'REFUND')).toBe('DEBIT');
  expect(ledgerDirectionFor('BET')).toBe('DEBIT');
  expect(ledgerDirectionFor('WIN')).toBe('CREDIT');
});
