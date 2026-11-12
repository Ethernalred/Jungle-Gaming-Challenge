import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuid } from 'uuid';
import { initOrm } from '../support/db';
setDefaultTimeout(60_000);

let orm: MikroORM;
const q = (sql: string, p: unknown[] = []) => orm.em.getConnection().execute(sql, p);
const now = new Date();

const wallet = async (balance = '100.00') => {
  const id = uuid();
  await q('insert into wallets (id, player_id, currency, balance, created_at, updated_at) values (?, ?, ?, ?, ?, ?)', [id, uuid(), 'BRL', balance, now, now]);
  return id;
};
// Insert a Wager Transaction with overridable columns.
const wager = (walletId: string, o: Record<string, unknown> = {}) => {
  const id = (o.id as string) ?? uuid();
  const row: Record<string, unknown> = {
    id, provider_id: 'prov', external_transaction_id: `ext-${id}`, idempotency_key: `key-${id}`, payload_hash: 'h',
    player_id: uuid(), wallet_id: walletId, round_id: 'r1', game_id: 'g1', kind: 'BET', status: 'PROCESSED',
    amount: '10.00', currency: 'BRL', created_at: now, updated_at: now, ...o,
  };
  const cols = Object.keys(row);
  return q(`insert into wager_transactions (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c])).then(() => id);
};
const entry = (walletId: string, txId: string, o: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: uuid(), wallet_id: walletId, transaction_id: txId, direction: 'DEBIT', amount: '10.00', currency: 'BRL',
    balance_before: '100.00', balance_after: '90.00', created_at: now, ...o,
  };
  const cols = Object.keys(row);
  return q(`insert into wallet_ledger_entries (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]));
};
const refuses = async (p: Promise<unknown>, constraint: string) => {
  const err: any = await p.then(() => null, (e) => e);
  expect(err).not.toBeNull();
  expect(String(err.message)).toContain(constraint);
};

beforeAll(async () => { orm = await initOrm(); });
afterAll(() => orm.close());

test('wallets: balance >= 0 and unique (player_id, currency)', async () => {
  await refuses(wallet('-0.01'), 'wallets_balance_non_negative');
  const player = uuid();
  const ins = () => q('insert into wallets (id, player_id, currency, balance, created_at, updated_at) values (?, ?, ?, ?, ?, ?)', [uuid(), player, 'BRL', '1.00', now, now]);
  await ins();
  await refuses(ins(), 'wallets_player_currency_unique');
});

test('Wager Transaction kind and status checks', async () => {
  const w = await wallet();
  await refuses(wager(w, { kind: 'DEPOSIT' }), 'wager_transactions_kind_check');
  await refuses(wager(w, { status: 'DONE' }), 'wager_transactions_status_check');
});

test('amount check (D6): > 0, or 0 only for LOSS', async () => {
  const w = await wallet();
  await refuses(wager(w, { amount: '0.00' }), 'wager_transactions_amount_check');
  await refuses(wager(w, { amount: '-1.00', kind: 'LOSS' }), 'wager_transactions_amount_check');
  await wager(w, { amount: '0.00', kind: 'LOSS' });
});

test('OPENING checks (D10): provider internal, opening ids, Round/game only null for OPENING', async () => {
  const w = await wallet();
  const key = `opening:${w}`;
  const opening = { kind: 'OPENING', round_id: null, game_id: null, provider_id: 'internal', external_transaction_id: key, idempotency_key: key };
  await refuses(wager(w, { ...opening, provider_id: 'prov' }), 'wager_transactions_opening_provider_check');
  await refuses(wager(w, { ...opening, external_transaction_id: 'x' }), 'wager_transactions_opening_ids_check');
  await refuses(wager(w, { round_id: null }), 'wager_transactions_round_game_check');
  await refuses(wager(w, { game_id: null }), 'wager_transactions_round_game_check');
  await wager(w, opening);
});

test('idempotency unique keys (D13)', async () => {
  const w = await wallet();
  const [k, e] = [uuid(), uuid()];
  await wager(w, { provider_id: 'p1', idempotency_key: k, external_transaction_id: e });
  await refuses(wager(w, { provider_id: 'p1', idempotency_key: k, external_transaction_id: uuid() }), 'wager_transactions_idempotency_unique');
  await refuses(wager(w, { provider_id: 'p1', idempotency_key: uuid(), external_transaction_id: e }), 'wager_transactions_external_id_unique');
  await wager(w, { provider_id: 'p2', idempotency_key: k, external_transaction_id: e }); // other Provider is free
});

test('one Processed Reversal per Reference, REFUND or ROLLBACK (D8)', async () => {
  const w = await wallet();
  const bet = await wager(w);
  await wager(w, { kind: 'REFUND', reference_transaction_id: bet });
  await refuses(wager(w, { kind: 'ROLLBACK', reference_transaction_id: bet }), 'wager_transactions_one_reversal');
  await wager(w, { kind: 'ROLLBACK', status: 'REJECTED', reference_transaction_id: bet }); // only PROCESSED ones count
});

test('Ledger Entry arithmetic, positive amount, unique (wallet, Wager Transaction)', async () => {
  const w = await wallet();
  const tx = await wager(w);
  await refuses(entry(w, tx, { balance_after: '95.00' }), 'ledger_arithmetic_check');
  await refuses(entry(w, tx, { direction: 'CREDIT' }), 'ledger_arithmetic_check');
  await refuses(entry(w, tx, { amount: '0.00', balance_after: '100.00' }), 'ledger_amount_positive');
  await entry(w, tx);
  await refuses(entry(w, tx), 'ledger_wallet_transaction_unique');
});

test('Ledger Entries are immutable: trigger refuses the owner, the app role has no grant', async () => {
  const w = await wallet();
  const tx = await wager(w);
  await entry(w, tx);
  await refuses(q('update wallet_ledger_entries set amount = ? where wallet_id = ?', ['1.00', w]), 'immutable');
  await refuses(q('delete from wallet_ledger_entries where wallet_id = ?', [w]), 'immutable');
  const asApp = (sql: string) => orm.em.fork().transactional(async (em) => {
    await em.execute('set local role jungle_app');
    await em.execute(sql, [w]);
  });
  await refuses(asApp('update wallet_ledger_entries set amount = 1 where wallet_id = ?'), 'permission denied');
  await refuses(asApp('delete from wallet_ledger_entries where wallet_id = ?'), 'permission denied');
  await asApp('select * from wallet_ledger_entries where wallet_id = ?'); // can still read
});
