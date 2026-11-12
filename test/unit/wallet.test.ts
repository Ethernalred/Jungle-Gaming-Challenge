import { expect, test } from 'bun:test';
import { Wallet } from '../../src/domain/wallet';
import { WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, InsufficientBalanceError, InvalidLedgerEntryError } from '../../src/domain/errors';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
const open = () => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('100.00'), at });
const mv = (a: string, c = 'BRL') => ({ entryId: 'e', transactionId: 't', money: Money.from({ amount: a, currency: c }), at });

test('open: version 1 with the initial Balance', () => {
  const w = open();
  expect([w.version, w.balance.toString()]).toEqual([1, '100.00']);
});

test('debit and credit return a balanced Ledger Entry and bump version', () => {
  const w = open();
  const d = w.debit(mv('30.00'));
  expect([d.direction, d.balanceBefore.toString(), d.balanceAfter.toString(), d.isBalanced()]).toEqual(['DEBIT', '100.00', '70.00', true]);
  const c = w.credit(mv('5.50'));
  expect([c.balanceAfter.toString(), w.balance.toString(), w.version]).toEqual(['75.50', '75.50', 3]);
});

test('debit below zero is refused and leaves the Wallet untouched', () => {
  const w = open();
  expect(() => w.debit(mv('100.01'))).toThrow(InsufficientBalanceError);
  expect([w.balance.toString(), w.version]).toEqual(['100.00', 1]);
});

test('currency mismatch is refused', () => {
  expect(() => open().credit(mv('1.00', 'USD'))).toThrow(CurrencyMismatchError);
});

test('WalletLedgerEntry.create checks the arithmetic; entries are frozen', () => {
  const base = { id: 'e', walletId: 'w', transactionId: 't', direction: 'CREDIT' as const, money: brl('10.00'), balanceBefore: brl('1.00'), createdAt: at };
  expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('12.00') })).toThrow(InvalidLedgerEntryError);
  const e = WalletLedgerEntry.create({ ...base, balanceAfter: brl('11.00') });
  expect(Object.isFrozen(e)).toBe(true);
});

test('a Ledger Entry of 0.00 is refused even though its arithmetic balances', () => {
  const zero = { id: 'e', walletId: 'w', transactionId: 't', direction: 'CREDIT' as const, money: brl('0.00'), balanceBefore: brl('1.00'), balanceAfter: brl('1.00'), createdAt: at };
  expect(() => WalletLedgerEntry.create(zero)).toThrow(InvalidLedgerEntryError);
  expect(brl('0.01').isZero()).toBe(false);
});
