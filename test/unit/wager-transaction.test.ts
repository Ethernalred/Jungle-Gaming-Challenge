import { expect, test } from 'bun:test';
import { InvalidTransactionStateError, ValidationError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { WagerTransaction, payloadHash } from '../../src/domain/wager-transaction';

const at = new Date('2026-01-01T00:00:00Z');
const base = {
  id: 'a', idempotencyKey: 'p:1', providerId: 'p', externalTransactionId: '1', playerId: 'pl', walletId: 'w',
  roundId: 'r', gameId: 'g', kind: 'BET', money: Money.from({ amount: '25.00', currency: 'BRL' }), at,
};
const bal = Money.from({ amount: '75.00', currency: 'BRL' });

test('create: PENDING; affectsBalance / requiresReference by Kind', () => {
  const bet = WagerTransaction.create(base);
  expect(bet.status).toBe('PENDING');
  expect(bet.affectsBalance).toBe(true);
  expect(bet.requiresReference).toBe(false);
  expect(WagerTransaction.create({ ...base, kind: 'LOSS' }).affectsBalance).toBe(false);
  expect(WagerTransaction.create({ ...base, kind: 'WIN' }).affectsBalance).toBe(true);
  expect(WagerTransaction.create({ ...base, kind: 'REFUND', referenceExternalTransactionId: 'x' }).requiresReference).toBe(true);
});

test('create: OPENING, unknown Kind and bad amounts are validation errors; LOSS accepts 0.00', () => {
  const zero = Money.from({ amount: '0.00', currency: 'BRL' });
  expect(() => WagerTransaction.create({ ...base, kind: 'OPENING' })).toThrow(ValidationError);
  expect(() => WagerTransaction.create({ ...base, kind: 'NOPE' })).toThrow(ValidationError);
  expect(() => WagerTransaction.create({ ...base, money: zero })).toThrow(ValidationError);
  expect(() => WagerTransaction.create({ ...base, kind: 'WIN', money: zero })).toThrow(ValidationError);
  expect(WagerTransaction.create({ ...base, kind: 'LOSS', money: zero }).status).toBe('PENDING');
  expect(() => WagerTransaction.create({ ...base, roundId: '' })).toThrow(ValidationError);
});

test('transitions (D11): PENDING -> PROCESSED | REJECTED | PENDING_REFERENCE; final statuses have no exits', () => {
  const p = WagerTransaction.create(base);
  p.markProcessed(bal, at);
  expect(p.status).toBe('PROCESSED');
  expect(p.balanceSnapshot?.toString()).toBe('75.00');
  expect(() => p.markProcessed(bal, at)).toThrow(InvalidTransactionStateError);
  expect(() => p.reject('INSUFFICIENT_FUNDS', bal, at)).toThrow(InvalidTransactionStateError);

  const r = WagerTransaction.create(base);
  r.reject('INSUFFICIENT_FUNDS', bal, at);
  expect(r.status).toBe('REJECTED');
  expect(r.failureCode).toBe('INSUFFICIENT_FUNDS');
  expect(() => r.markPendingReference(bal, at)).toThrow(InvalidTransactionStateError);

  const w = WagerTransaction.create(base);
  w.markPendingReference(bal, at);
  expect(w.status).toBe('PENDING_REFERENCE');
  expect(() => w.markPendingReference(bal, at)).toThrow(InvalidTransactionStateError);
  w.fail('INTERNAL_ERROR', bal, at);
  expect(w.status).toBe('FAILED');
  expect(() => w.markProcessed(bal, at)).toThrow(InvalidTransactionStateError);
  expect(() => WagerTransaction.create(base).fail('INTERNAL_ERROR', bal, at)).toThrow(InvalidTransactionStateError);
});

test('payload hash (D14): stable, key-order independent, business fields only, same key different payload does not match', () => {
  const a = WagerTransaction.create(base);
  expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  expect(WagerTransaction.create({ ...base, id: 'other', idempotencyKey: 'different', at: new Date() }).matchesPayload(a.payloadHash)).toBe(true);
  expect(WagerTransaction.create({ ...base, money: Money.from({ amount: '26.00', currency: 'BRL' }) }).matchesPayload(a.payloadHash)).toBe(false);
  expect(WagerTransaction.create({ ...base, money: Money.from({ amount: '25.00', currency: 'USD' }) }).matchesPayload(a.payloadHash)).toBe(false);
  expect(WagerTransaction.create({ ...base, kind: 'WIN' }).matchesPayload(a.payloadHash)).toBe(false);
  const f = { providerId: 'p', externalTransactionId: '1', playerId: 'pl', walletId: 'w', roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
  expect(payloadHash(f)).toBe(a.payloadHash);
  expect(payloadHash({ ...f, money: { currency: 'BRL', amount: '25.00' } })).toBe(a.payloadHash); // key order irrelevant
  expect(payloadHash({ ...f, referenceExternalTransactionId: undefined })).toBe(a.payloadHash); // omitted when absent
  expect(payloadHash({ ...f, referenceExternalTransactionId: 'x' })).not.toBe(a.payloadHash);
});

test('REFUND and ROLLBACK without a Reference are validation errors (§7 rule 1)', () => {
  expect(() => WagerTransaction.create({ ...base, kind: 'REFUND' })).toThrow(ValidationError);
  expect(() => WagerTransaction.create({ ...base, kind: 'ROLLBACK' })).toThrow(ValidationError);
});

// Verify reference requirements and terminal-state guards.
test('create: non-string, blank or whitespace-only ids and a null/empty Reference id are ValidationError, never a TypeError (which would surface as 500)', () => {
  for (const bad of [123, null, undefined, '', '   ']) expect(() => WagerTransaction.create({ ...base, providerId: bad as any })).toThrow(ValidationError);
  for (const bad of [null, '', 7]) expect(() => WagerTransaction.create({ ...base, kind: 'REFUND', referenceExternalTransactionId: bad as any })).toThrow(ValidationError);
  expect(WagerTransaction.create({ ...base, kind: 'ROLLBACK', referenceExternalTransactionId: 'x' }).requiresReference).toBe(true);
  expect(WagerTransaction.create({ ...base, kind: 'WIN', referenceExternalTransactionId: 'x' }).state.referenceExternalTransactionId).toBe('x');
});

test('a PENDING_REFERENCE Wager Transaction can still become PROCESSED or REJECTED (the worker resolves it)', () => {
  const pending = () => { const t = WagerTransaction.create({ ...base, kind: 'REFUND', referenceExternalTransactionId: 'x' }); t.markPendingReference(bal, at); return t; };
  const a = pending(); a.markProcessed(bal, at); expect(a.status).toBe('PROCESSED');
  const b = pending(); b.reject('REFERENCE_NOT_FOUND', bal, at); expect(b.status).toBe('REJECTED');
});
