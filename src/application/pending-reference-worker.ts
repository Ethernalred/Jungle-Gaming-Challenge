import { Clock } from '../domain/clock';
import { TransientError } from '../domain/errors';
import { IdGenerator } from '../domain/id-generator';
import { eventsFor } from '../domain/outbox';
import { v7 as uuid } from 'uuid';
import { log } from '../infrastructure/log';
import { retries, wagerTransactions } from '../infrastructure/metrics/metrics';
import { WagerTransaction } from '../domain/wager-transaction';
import { runWith, traceFor } from './context';
import { resolveReference } from './resolve-reference';
import { WagerTransactionRepository } from './wager-ports';

/** D27: first retry 2 s after arrival, then 2 s x 2^n; the 8th failed attempt (about 8.5 min in) rejects REFERENCE_NOT_FOUND. */
export const MAX_ATTEMPTS = 8;
export const retryDelayMs = (attempts: number) => 2000 * 2 ** attempts;

/**
 * Re-runs resolveReference on stored PENDING_REFERENCE rows (D9, D27). Each row is handled in its own DB transaction
 * (Wallet lock first, then the row claimed SKIP LOCKED), so many workers never process a row twice.
 */
export class PendingReferenceWorker {
  private timer?: NodeJS.Timeout;
  private running: Promise<unknown> = Promise.resolve();
  private stopped = true;

  constructor(
    private readonly repo: WagerTransactionRepository, private readonly clock: Clock, private readonly ids: IdGenerator,
    private readonly resolve: typeof resolveReference = resolveReference, // overridable so tests can inject a failure
    private readonly pollMs = 1000, private readonly batchSize = 20,
  ) {}

  onModuleInit() { if (process.env.PENDING_REFERENCE_WORKER !== 'off') this.start(); }
  onModuleDestroy() { return this.stop(); }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = () => {
      this.running = this.tick().catch(() => {}).finally(() => { if (!this.stopped) this.timer = setTimeout(loop, this.pollMs); });
    };
    loop();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One pass over the due rows. Returns how many rows this worker handled. */
  async tick(): Promise<number> {
    let handled = 0;
    for (const due of await this.repo.findDuePending(this.clock.now(), this.batchSize)) {
      try {
        if (await runWith({ correlationId: uuid() }, () => this.attempt(due.id, due.walletId))) handled++; // the original request's id is not stored: a worker attempt gets its own, traced by transactionId
      } catch (e) {
        if (e instanceof TransientError) continue; // stays due, next tick retries
        await this.fail(due.id, due.walletId).catch(() => {}); // D11: non-transient, non-business error -> FAILED
        handled++;
      }
    }
    return handled;
  }

  private attempt(id: string, walletId: string): Promise<boolean> {
    return this.repo.withWalletLocked(walletId, async (locked) => {
      const claimed = await locked.claimPending(id, this.clock.now());
      if (!claimed || !locked.wallet) return false; // another worker has it, it already left PENDING_REFERENCE, or it is no longer due
      const { tx, attempts } = claimed;
      const at = this.clock.now();
      const wallet = locked.wallet;
      const entry = await this.resolve(tx, locked, this.ids, at);
      if (tx.status !== 'PENDING_REFERENCE') {
        if (entry) await locked.saveMovement(wallet, entry);
        await locked.updatePending(tx, attempts, null);
        await locked.emit(eventsFor(tx, entry, wallet.version, this.ids, at, traceFor(tx.id)));
        this.done(tx);
      } else if (attempts + 1 >= MAX_ATTEMPTS) {
        tx.reject('REFERENCE_NOT_FOUND', wallet.balance, at);
        await locked.updatePending(tx, attempts + 1, null);
        await locked.emit(eventsFor(tx, null, wallet.version, this.ids, at, traceFor(tx.id)));
        this.done(tx);
      } else {
        retries.inc({ source: 'pending_reference' });
        await locked.updatePending(tx, attempts + 1, new Date(at.getTime() + retryDelayMs(attempts + 1)));
      }
      return true;
    });
  }

  private done(tx: WagerTransaction) {
    wagerTransactions.inc({ status: tx.status });
    log.info({ transactionId: tx.id, walletId: tx.state.walletId, providerId: tx.state.providerId, status: tx.status }, 'pending Wager Transaction resolved');
  }

  private fail(id: string, walletId: string) {
    return this.repo.withWalletLocked(walletId, async (locked) => {
      const claimed = await locked.claimPending(id, this.clock.now());
      if (!claimed || !locked.wallet) return;
      claimed.tx.fail('INTERNAL_ERROR', locked.wallet.balance, this.clock.now());
      await locked.updatePending(claimed.tx, claimed.attempts, null);
      this.done(claimed.tx); // no event: D23 defines none for FAILED
    });
  }
}
