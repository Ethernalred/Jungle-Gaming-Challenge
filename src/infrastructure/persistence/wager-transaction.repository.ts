import { LockMode, MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { LockedWallet, WagerTransactionRepository } from '../../application/wager-ports';
import { DomainError, TransientError } from '../../domain/errors';
import { Money } from '../../domain/money';
import { WagerTransaction } from '../../domain/wager-transaction';
import { lockConflicts } from '../metrics/metrics';
import { writeOutbox } from './outbox';
import { entryToRow, walletFromRow } from './wallet.mappers';
import { LedgerEntrySchema, WalletSchema } from './wallet.schema';

const DUE = "coalesce(next_attempt_at, created_at + interval '2 seconds')"; // when a PENDING_REFERENCE row is next due
const COLS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, player_id, wallet_id, round_id, game_id, kind, status,
  failure_code, amount::text as amount, currency, reference_external_transaction_id, reference_transaction_id,
  balance_snapshot::text as balance_snapshot, (select w.currency from wallets w where w.id = wallet_id) as wallet_currency, processed_at, created_at, updated_at`;

// balance_snapshot is in the Wallet's currency, which differs from `currency` on a CURRENCY_MISMATCH row.
const fromRow = (r: any): WagerTransaction => {
  const c = r.currency.trim();
  return WagerTransaction.rehydrate({
    id: r.id, providerId: r.provider_id, externalTransactionId: r.external_transaction_id, idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash, playerId: r.player_id, walletId: r.wallet_id, roundId: r.round_id, gameId: r.game_id,
    kind: r.kind, status: r.status, failureCode: r.failure_code, money: Money.from({ amount: r.amount, currency: c }),
    referenceExternalTransactionId: r.reference_external_transaction_id, referenceTransactionId: r.reference_transaction_id,
    balanceSnapshot: r.balance_snapshot === null ? null : Money.from({ amount: r.balance_snapshot, currency: r.wallet_currency.trim() }),
    processedAt: r.processed_at && new Date(r.processed_at), createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at), // raw rows may carry strings
  });
};

// Lock timeout (55P03), deadlock/serialization (40P01/40001) and connection-level failures are transient: the caller may resend.
function translate(e: unknown): unknown {
  if (e instanceof DomainError) return e;
  const code: string | undefined = (e as any)?.code ?? (e as any)?.cause?.code;
  if (code === '55P03' || code === '40P01') lockConflicts.inc();
  if (code && (['55P03', '40P01', '40001', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code) || /^(08|53|57P)/.test(code))) {
    return new TransientError(`Temporarily unavailable (${code})`);
  }
  if (/connection terminated|timeout exceeded when trying to connect/i.test((e as any)?.message ?? '')) return new TransientError('Temporarily unavailable');
  return e;
}

export class MikroWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly orm: MikroORM) { super(); }

  async withWalletLocked<T>(walletId: string, fn: (locked: LockedWallet) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em: EntityManager) => {
        await em.execute(`set local lock_timeout = '2s'`);
        const row = await em.findOne(WalletSchema, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        return fn(lockedWallet(em, row ? walletFromRow(row) : null));
      });
    } catch (e) {
      throw translate(e);
    }
  }

  async findDuePending(now: Date, limit: number) {
    try {
      const rows = await this.orm.em.fork().execute(
        `select id, wallet_id from wager_transactions where status = 'PENDING_REFERENCE' and ${DUE} <= ?
         order by coalesce(next_attempt_at, created_at) limit ?`, [now, limit]);
      return rows.map((r: any) => ({ id: r.id as string, walletId: r.wallet_id as string }));
    } catch (e) {
      throw translate(e);
    }
  }

  async findById(id: string) {
    return this.one('where id = ?', [id]);
  }

  async findByExternal(providerId: string, externalTransactionId: string) {
    return this.one('where provider_id = ? and external_transaction_id = ?', [providerId, externalTransactionId]);
  }

  private async one(where: string, params: unknown[]) {
    try {
      const [r] = await this.orm.em.fork().execute(`select ${COLS} from wager_transactions ${where}`, params);
      return r ? fromRow(r) : null;
    } catch (e) {
      throw translate(e);
    }
  }
}

const lockedWallet = (em: EntityManager, wallet: LockedWallet['wallet']): LockedWallet => ({
  wallet,
  async insert(tx) {
    const s = tx.state;
    const rows = await em.execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, player_id, wallet_id, round_id, game_id,
         kind, status, failure_code, amount, currency, reference_external_transaction_id, reference_transaction_id, balance_snapshot, processed_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
      [s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash, s.playerId, s.walletId, s.roundId, s.gameId,
        s.kind, s.status, s.failureCode, s.money.toString(), s.money.currency, s.referenceExternalTransactionId, s.referenceTransactionId,
        s.balanceSnapshot?.toString() ?? null, s.processedAt, s.createdAt, s.updatedAt],
    );
    return rows.length > 0;
  },
  async findConflicting(providerId, key, externalId) {
    const rows = await em.execute(
      `select ${COLS} from wager_transactions where provider_id = ? and (idempotency_key = ? or external_transaction_id = ?)`,
      [providerId, key, externalId]);
    return rows.map(fromRow);
  },
  async findReference(providerId, externalId) {
    const [r] = await em.execute(`select ${COLS} from wager_transactions where provider_id = ? and external_transaction_id = ?`, [providerId, externalId]);
    return r ? fromRow(r) : null;
  },
  async hasProcessedReversal(id) {
    const rows = await em.execute(`select 1 from wager_transactions where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`, [id]);
    return rows.length > 0;
  },
  async claimPending(id, now) {
    const [r] = await em.execute(
      `select ${COLS}, reference_attempts from wager_transactions where id = ? and status = 'PENDING_REFERENCE' and ${DUE} <= ? for update skip locked`, [id, now]);
    return r ? { tx: fromRow(r), attempts: Number(r.reference_attempts) } : null;
  },
  async updatePending(tx, attempts, nextAttemptAt) {
    const s = tx.state;
    await em.execute(
      `update wager_transactions set status = ?, failure_code = ?, reference_transaction_id = ?, balance_snapshot = ?, processed_at = ?, updated_at = ?,
         reference_attempts = ?, next_attempt_at = ? where id = ?`,
      [s.status, s.failureCode, s.referenceTransactionId, s.balanceSnapshot?.toString() ?? null, s.processedAt, s.updatedAt, attempts, nextAttemptAt, s.id]);
  },
  emit: (events) => writeOutbox(em, events),
  async saveMovement(w, entry) {
    await em.insert(LedgerEntrySchema, entryToRow(entry));
    await em.execute('update wallets set balance = ?, version = ?, updated_at = ? where id = ?', [w.balance.toString(), w.version, w.updatedAt, w.id]);
  },
});
