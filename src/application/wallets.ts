import { Clock } from '../domain/clock';
import { NotFoundError, ValidationError } from '../domain/errors';
import { IdGenerator } from '../domain/id-generator';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/ledger-entry';
import { log } from '../infrastructure/log';
import { traceFor } from './context';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/integration-event';
import { OpeningWager, WalletRepository } from './ports';
import { divergenceCounter } from './reconciliation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

export class WalletService {
  constructor(private readonly wallets: WalletRepository, private readonly clock: Clock, private readonly ids: IdGenerator) {}

  async open(input: { playerId: unknown; initialBalance: any }): Promise<Wallet> {
    if (!isUuid(input.playerId)) throw new ValidationError('playerId must be a UUID');
    const b = input.initialBalance;
    const initialBalance = Money.from({ amount: b?.amount, currency: b?.currency }); // InvalidMoneyError -> 400
    const at = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId: input.playerId, initialBalance, at });
    const transactionId = this.ids.next();
    let opening: OpeningWager | undefined;
    if (initialBalance.isPositive()) {
      const entry = WalletLedgerEntry.create({
        id: this.ids.next(), walletId: wallet.id, transactionId, direction: 'CREDIT',
        money: initialBalance, balanceBefore: Money.zero(initialBalance.currency), balanceAfter: initialBalance, createdAt: at,
      });
      const trace = traceFor(transactionId);
      const processed = new WagerTransactionProcessed({
        eventId: this.ids.next(), occurredAt: at, ...trace,
        data: {
          transactionId, walletId: wallet.id, playerId: wallet.playerId, providerId: 'internal', externalTransactionId: `opening:${wallet.id}`,
          kind: 'OPENING', money: initialBalance.toJSON(), balance: initialBalance.toJSON(),
        },
      });
      opening = { transactionId, entry, events: [processed, WalletBalanceChanged.from(entry, wallet.version, this.ids.next(), { correlationId: trace.correlationId, causationId: processed.eventId })] };
    }
    await this.wallets.open(wallet, opening);
    return wallet;
  }

  async get(id: string): Promise<Wallet> {
    const w = isUuid(id) ? await this.wallets.find(id) : null;
    if (!w) throw new NotFoundError('Wallet not found');
    return w;
  }

  /** Reports a Divergence (log + counter), never fixes it (D19). */
  async reconcile(walletId: string) {
    const r = isUuid(walletId) ? await this.wallets.reconcile(walletId) : null;
    if (!r) throw new NotFoundError('Wallet not found');
    const difference = r.stored.subtract(r.calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      divergenceCounter.inc();
      log.warn({ walletId }, 'Divergence: stored Balance differs from the Ledger Entries'); // amounts stay out of logs (D28)
    }
    return { walletId, stored: r.stored, calculated: r.calculated, difference, consistent, checkedEntries: r.checkedEntries };
  }

  /** Cursor = base64url("createdAtISO|id"); opaque to callers (D18). */
  async ledger(walletId: string, cursor?: string, limit = 50) {
    await this.get(walletId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError('limit must be an integer 1..200');
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await this.wallets.ledgerPage(walletId, after, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null;
    return { items, nextCursor };
  }
}

function decodeCursor(cursor: string) {
  const [iso, id, ...rest] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(iso ?? '');
  if (rest.length || !isUuid(id) || Number.isNaN(createdAt.getTime())) throw new ValidationError('invalid cursor');
  return { createdAt, id };
}
