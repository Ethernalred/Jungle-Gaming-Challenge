import { WalletLedgerEntry, LedgerDirection } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { LedgerEntryRow, WalletRow } from './wallet.schema';

// NUMERIC(19,2) round-trips through its decimal string (ADR-0001).
const money = (amount: string, currency: string) => Money.from({ amount, currency });

export const walletToRow = (w: Wallet): WalletRow =>
  Object.assign(new WalletRow(), {
    id: w.id, playerId: w.playerId, currency: w.currency, balance: w.balance.toString(),
    version: w.version, createdAt: w.createdAt, updatedAt: w.updatedAt,
  });

export const walletFromRow = (r: WalletRow): Wallet =>
  Wallet.rehydrate({
    id: r.id, playerId: r.playerId, currency: r.currency.trim(), balance: money(r.balance, r.currency.trim()),
    version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt,
  });

export const entryToRow = (e: WalletLedgerEntry): LedgerEntryRow =>
  Object.assign(new LedgerEntryRow(), {
    id: e.id, walletId: e.walletId, transactionId: e.transactionId, direction: e.direction,
    amount: e.money.toString(), currency: e.money.currency,
    balanceBefore: e.balanceBefore.toString(), balanceAfter: e.balanceAfter.toString(), createdAt: e.createdAt,
  });

export const entryFromRow = (r: LedgerEntryRow): WalletLedgerEntry => {
  const c = r.currency.trim();
  return WalletLedgerEntry.rehydrate({
    id: r.id, walletId: r.walletId, transactionId: r.transactionId, direction: r.direction as LedgerDirection,
    money: money(r.amount, c), balanceBefore: money(r.balanceBefore, c), balanceAfter: money(r.balanceAfter, c), createdAt: r.createdAt,
  });
};
