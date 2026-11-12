import { InvalidLedgerEntryError } from './errors';
import { Money } from './money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string; // the Wager Transaction that caused it
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

// Immutable: readonly fields, no transition methods.
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(s: LedgerEntryState): WalletLedgerEntry {
    const e = WalletLedgerEntry.rehydrate(s);
    if (!s.money.isPositive()) throw new InvalidLedgerEntryError('Ledger Entry amount must be > 0');
    if (!e.isBalanced()) throw new InvalidLedgerEntryError('Ledger Entry arithmetic does not balance');
    return e;
  }

  /** Reconstruction from persistence: no validation. */
  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(s.id, s.walletId, s.transactionId, s.direction, s.money, s.balanceBefore, s.balanceAfter, s.createdAt);
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected = this.direction === 'CREDIT' ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
