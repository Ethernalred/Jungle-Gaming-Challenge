import { createHash } from 'node:crypto';
import { MikroORM, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { OpeningWager, WalletRepository } from '../../application/ports';
import { WalletAlreadyExistsError } from '../../domain/errors';
import { WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { writeOutbox } from './outbox';
import { entryFromRow, entryToRow, walletFromRow, walletToRow } from './wallet.mappers';
import { LedgerEntrySchema, WalletSchema } from './wallet.schema';

export class MikroWalletRepository extends WalletRepository {
  constructor(private readonly orm: MikroORM) { super(); }

  async open(wallet: Wallet, opening?: OpeningWager): Promise<void> {
    try {
      await this.orm.em.fork().transactional(async (em) => {
        await em.insert(WalletSchema, walletToRow(wallet));
        if (!opening) return;
        const key = `opening:${wallet.id}`;
        const amount = opening.entry.money.toString();
        await em.execute(
          `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, player_id, wallet_id,
             kind, status, amount, currency, balance_snapshot, processed_at, created_at, updated_at)
           values (?, 'internal', ?, ?, ?, ?, ?, 'OPENING', 'PROCESSED', ?, ?, ?, ?, ?, ?)`,
          [opening.transactionId, key, key, createHash('sha256').update(`${key}|${amount}|${wallet.currency}`).digest('hex'),
            wallet.playerId, wallet.id, amount, wallet.currency, wallet.balance.toString(), wallet.createdAt, wallet.createdAt, wallet.createdAt],
        );
        await em.insert(LedgerEntrySchema, entryToRow(opening.entry));
        await writeOutbox(em, opening.events);
      });
    } catch (e) {
      if (e instanceof UniqueConstraintViolationException && (e as any).constraint === 'wallets_player_currency_unique') {
        throw new WalletAlreadyExistsError('A Wallet already exists for this Player and currency');
      }
      throw e;
    }
  }

  async find(id: string): Promise<Wallet | null> {
    const row = await this.orm.em.fork().findOne(WalletSchema, { id });
    return row ? walletFromRow(row) : null;
  }

  async ledgerPage(walletId: string, after: { createdAt: Date; id: string } | null, limit: number): Promise<WalletLedgerEntry[]> {
    const rows = await this.orm.em.fork().find(
      LedgerEntrySchema,
      after
        ? { walletId, $or: [{ createdAt: { $gt: after.createdAt } }, { createdAt: after.createdAt, id: { $gt: after.id } }] }
        : { walletId },
      { orderBy: { createdAt: 'asc', id: 'asc' }, limit },
    );
    return rows.map(entryFromRow);
  }

  async reconcile(walletId: string) {
    return this.orm.em.fork().transactional(async (em) => {
      const [w] = await em.execute('select balance::text as b, currency from wallets where id = ? for share', [walletId]);
      if (!w) return null;
      const currency = String(w.currency).trim();
      const [l] = await em.execute(
        `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text as s, count(*)::int as n
         from wallet_ledger_entries where wallet_id = ?`, [walletId]);
      return { stored: Money.from({ amount: w.b, currency }), calculated: Money.from({ amount: l.s, currency }), checkedEntries: Number(l.n) };
    });
  }
}
