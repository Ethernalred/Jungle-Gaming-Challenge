import { CurrencyMismatchError, InsufficientBalanceError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string; // the Wager Transaction causing the movement
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** A new Wallet starts at version 1 holding the initial Balance (its OPENING Ledger Entry is made by the caller). */
  static open(p: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    return new Wallet(p.id, p.playerId, p.initialBalance.currency, p.initialBalance, 1, p.at, p.at);
  }

  /** Reconstruction from persistence; no revalidation. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  credit(p: MovementProps): WalletLedgerEntry {
    return this.move('CREDIT', p);
  }

  debit(p: MovementProps): WalletLedgerEntry {
    return this.move('DEBIT', p);
  }

  private move(direction: LedgerDirection, p: MovementProps): WalletLedgerEntry {
    if (p.money.currency !== this.currency) throw new CurrencyMismatchError(`Wallet is ${this.currency}, got ${p.money.currency}`);
    const before = this._balance;
    const after = direction === 'CREDIT' ? before.add(p.money) : before.subtract(p.money);
    if (after.isNegative()) throw new InsufficientBalanceError('Balance would become negative');
    const entry = WalletLedgerEntry.create({
      id: p.entryId, walletId: this.id, transactionId: p.transactionId, direction,
      money: p.money, balanceBefore: before, balanceAfter: after, createdAt: p.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = p.at;
    return entry;
  }
}
