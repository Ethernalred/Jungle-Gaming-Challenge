import { WalletLedgerEntry } from '../domain/ledger-entry';
import { IntegrationEvent } from '../domain/events/integration-event';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';

/** What a caller may do inside the one DB transaction that holds the Wallet lock. */
export interface LockedWallet {
  /** The Wallet read FOR UPDATE, or null if it does not exist. */
  readonly wallet: Wallet | null;
  /** INSERT ... ON CONFLICT DO NOTHING (D13). false = a row with the same key or external id already exists. */
  insert(tx: WagerTransaction): Promise<boolean>;
  /** Existing rows with this Idempotency Key or this (provider, external id). */
  findConflicting(providerId: string, idempotencyKey: string, externalTransactionId: string): Promise<WagerTransaction[]>;
  /** The Reference: the Provider's earlier Wager Transaction by its external id, or null if not (yet) committed. */
  findReference(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Whether the Wager Transaction already has a Processed Reversal (D8). */
  hasProcessedReversal(transactionId: string): Promise<boolean>;
  /** Persist a Balance change: the Ledger Entry and the Wallet's new Balance and version. */
  saveMovement(wallet: Wallet, entry: WalletLedgerEntry): Promise<void>;
  /** The PENDING_REFERENCE row `id` if it is still pending, FOR UPDATE SKIP LOCKED (D27); null if taken or no longer pending. */
  claimPending(id: string, now: Date): Promise<{ tx: WagerTransaction; attempts: number } | null>;
  /** Persist a stored PENDING_REFERENCE row after a worker attempt: Status, Failure Code, Reference link, snapshot, attempts, next due time. */
  updatePending(tx: WagerTransaction, attempts: number, nextAttemptAt: Date | null): Promise<void>;
  /** Write integration events to the outbox in this same DB transaction (D23). */
  emit(events: IntegrationEvent<any>[]): Promise<void>;
}

export abstract class WagerTransactionRepository {
  /**
   * Runs `fn` in one DB transaction holding the Wallet row FOR UPDATE with lock_timeout 2s (ADR-0002, D15).
   * A lock timeout or infrastructure failure throws TransientError; `fn` throwing rolls everything back.
   */
  abstract withWalletLocked<T>(walletId: string, fn: (locked: LockedWallet) => Promise<T>): Promise<T>;
  /** Ids (and Wallets) of PENDING_REFERENCE rows whose next attempt is due at `now`, oldest first. No lock: the worker claims each one. */
  abstract findDuePending(now: Date, limit: number): Promise<{ id: string; walletId: string }[]>;
  abstract findById(id: string): Promise<WagerTransaction | null>;
  abstract findByExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
}
