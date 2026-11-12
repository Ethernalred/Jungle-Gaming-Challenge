import { Clock } from '../domain/clock';
import {
  ExternalIdConflictError, IdempotencyConflictError, ValidationError, WalletNotFoundError, WalletPlayerMismatchError,
} from '../domain/errors';
import { IdGenerator } from '../domain/id-generator';
import { WalletLedgerEntry } from '../domain/ledger-entry';
import { eventsFor } from '../domain/outbox';
import { Money } from '../domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { log } from '../infrastructure/log';
import { duplicates, processingSeconds, wagerTransactions } from '../infrastructure/metrics/metrics';
import { traceFor } from './context';
import { resolveReference } from './resolve-reference';
import { isUuid } from './wallets';
import { LockedWallet, WagerTransactionRepository } from './wager-ports';

/** Transport-agnostic input: HTTP and the queue both build this (unvalidated: `unknown` fields are checked here). */
export interface SubmitWagerTransactionInput {
  idempotencyKey: unknown; // header on HTTP, data.idempotencyKey on the queue
  providerId: unknown;
  externalTransactionId: unknown;
  playerId: unknown;
  walletId: unknown;
  roundId: unknown;
  gameId: unknown;
  kind: unknown;
  money: any;
  referenceExternalTransactionId?: unknown;
}

export interface SubmitResult {
  transaction: WagerTransaction;
  /** true when this call returned an already-stored result (Replay). */
  replay: boolean;
}

export class SubmitWagerTransaction {
  constructor(private readonly repo: WagerTransactionRepository, private readonly clock: Clock, private readonly ids: IdGenerator) {}

  /** `inTransaction` runs first inside the DB transaction (the queue consumer records its inbox row there). */
  async execute(i: SubmitWagerTransactionInput, inTransaction?: () => Promise<void>): Promise<SubmitResult> {
    const stop = processingSeconds.startTimer();
    try {
      return await this.run(i, inTransaction);
    } finally { stop(); }
  }

  private async run(i: SubmitWagerTransactionInput, inTransaction?: () => Promise<void>): Promise<SubmitResult> {
    if (!isUuid(i.walletId) || !isUuid(i.playerId)) throw new ValidationError('walletId and playerId must be UUIDs');
    const at = this.clock.now();
    const tx = WagerTransaction.create({
      id: this.ids.next(), idempotencyKey: i.idempotencyKey as string, providerId: i.providerId as string,
      externalTransactionId: i.externalTransactionId as string, playerId: i.playerId, walletId: i.walletId,
      roundId: i.roundId as string, gameId: i.gameId as string, kind: i.kind as string,
      money: Money.from({ amount: i.money?.amount, currency: i.money?.currency }), // InvalidMoneyError -> 400
      referenceExternalTransactionId: i.referenceExternalTransactionId as string | undefined, at,
    });
    return this.repo.withWalletLocked(i.walletId, async (locked) => {
      await inTransaction?.();
      const wallet = locked.wallet;
      if (!wallet) throw new WalletNotFoundError('Wallet not found'); // D16: nothing stored
      if (wallet.playerId !== i.playerId) throw new WalletPlayerMismatchError('Wallet does not belong to this Player');

      let entry: WalletLedgerEntry | null = null;
      const movement = { entryId: this.ids.next(), transactionId: tx.id, money: tx.money, at };
      if (tx.money.currency !== wallet.currency) {
        tx.reject('CURRENCY_MISMATCH', wallet.balance, at);
      } else if (tx.requiresReference || tx.state.referenceExternalTransactionId) {
        entry = await resolveReference(tx, locked, this.ids, at); // D9: also stores PENDING_REFERENCE
      } else if (tx.kind === 'BET' && wallet.balance.isLessThan(tx.money)) {
        tx.reject('INSUFFICIENT_FUNDS', wallet.balance, at);
      } else {
        if (tx.kind === 'BET') entry = wallet.debit(movement);
        else if (tx.kind === 'WIN') entry = wallet.credit(movement);
        // LOSS: PROCESSED, no Ledger Entry, no version change (D6, D15)
        tx.markProcessed(wallet.balance, at);
      }

      if (!(await locked.insert(tx))) return this.existing(locked, tx); // D13: Replay or conflict
      if (entry) await locked.saveMovement(wallet, entry);
      await locked.emit(eventsFor(tx, entry, wallet.version, this.ids, at, traceFor(tx.id)));
      return { transaction: tx, replay: false };
    }).then((r) => {
      if (r.replay) duplicates.inc({ source: 'replay' }); else wagerTransactions.inc({ status: r.transaction.status });
      const s = r.transaction.state;
      log.info({ transactionId: s.id, walletId: s.walletId, providerId: s.providerId, kind: s.kind, status: s.status, replay: r.replay }, 'wager transaction handled');
      return r;
    });
  }

  private async existing(locked: LockedWallet, tx: WagerTransaction): Promise<SubmitResult> {
    const rows = await locked.findConflicting(tx.state.providerId, tx.idempotencyKey, tx.state.externalTransactionId);
    const sameKey = rows.find((r) => r.idempotencyKey === tx.idempotencyKey && r.state.providerId === tx.state.providerId);
    if (sameKey) {
      if (sameKey.matchesPayload(tx.payloadHash)) return { transaction: sameKey, replay: true };
      throw new IdempotencyConflictError('Idempotency-Key was already used with a different payload');
    }
    throw new ExternalIdConflictError('externalTransactionId was already used with a different Idempotency-Key');
  }
}
