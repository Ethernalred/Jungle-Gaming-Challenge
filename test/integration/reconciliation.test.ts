import 'reflect-metadata';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { type INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuid } from 'uuid';
import { AppModule } from '../../src/app.module';
import { MikroWalletRepository } from '../../src/infrastructure/persistence/wallet.repository';
import { log, logTap } from '../../src/infrastructure/log';
import { divergenceCounter } from '../../src/application/reconciliation';
import { Money } from '../../src/domain/money';
import { expectBalanceMatchesLedger } from '../support/ledger';
setDefaultTimeout(60_000);

let app: INestApplication;
let base: string;
let orm: MikroORM;
const json = { 'content-type': 'application/json' };
const open = async (amount: string) =>
  (await (await fetch(`${base}/wallets`, { method: 'POST', headers: json, body: JSON.stringify({ playerId: uuid(), initialBalance: { amount, currency: 'BRL' } }) })).json()) as any;
const reconcile = (id: string) => fetch(`${base}/wallets/${id}/reconciliation`, { method: 'POST' });

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
  orm = app.get(MikroORM);
});
afterAll(() => app.close());

/** BET persistence flow: DB transaction, FOR UPDATE, Wallet domain debit, Ledger Entry + Wallet row. */
async function placeBet(walletId: string, stake: string) {
  const repo = new MikroWalletRepository(orm);
  await orm.em.fork().transactional(async (em) => {
    await em.execute('select 1 from wallets where id = ? for update', [walletId]);
    const wallet = (await repo.find(walletId))!;
    const txId = uuid();
    const at = new Date();
    await em.execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, player_id, wallet_id, round_id, game_id, kind, status, amount, currency, created_at, updated_at)
       values (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', 'BET', 'PROCESSED', ?, 'BRL', ?, ?)`, [txId, txId, txId, wallet.playerId, walletId, stake, at, at]);
    const e = wallet.debit({ entryId: uuid(), transactionId: txId, money: Money.from({ amount: stake, currency: 'BRL' }), at });
    await em.execute(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'DEBIT', ?, 'BRL', ?, ?, ?)`, [e.id, walletId, txId, stake, e.balanceBefore.toString(), e.balanceAfter.toString(), at]);
    await em.execute('update wallets set balance = ?, version = ?, updated_at = ? where id = ?', [wallet.balance.toString(), wallet.version, at, walletId]);
  });
}

test('consistent Wallet: response shape matches Requirements §9', async () => {
  const w = await open('975.00');
  const res = await reconcile(w.id);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    walletId: w.id,
    storedBalance: { amount: '975.00', currency: 'BRL' },
    calculatedBalance: { amount: '975.00', currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' },
    consistent: true,
    checkedEntries: 1,
  });
  await expectBalanceMatchesLedger(orm, w.id);
});

test('Wallet with no entries: calculated 0.00, 0 entries checked', async () => {
  const w = await open('0.00');
  const body = (await (await reconcile(w.id)).json()) as any;
  expect(body).toMatchObject({ consistent: true, checkedEntries: 0, calculatedBalance: { amount: '0.00' } });
});

test('forced Divergence: consistent false, warn logged, counter up, no row changed', async () => {
  const w = await open('100.00');
  const c = orm.em.getConnection();
  await c.execute("update wallets set balance = '90.00' where id = ?", [w.id]);
  const before = await c.execute('select * from wallets where id = ?', [w.id]);
  const lines: string[] = [];
  log.level = 'warn'; logTap.fn = (l) => lines.push(l);
  const n = divergenceCounter.value;
  const body = (await (await reconcile(w.id)).json()) as any;
  expect(body).toEqual({
    walletId: w.id,
    storedBalance: { amount: '90.00', currency: 'BRL' },
    calculatedBalance: { amount: '100.00', currency: 'BRL' },
    difference: { amount: '-10.00', currency: 'BRL' },
    consistent: false,
    checkedEntries: 1,
  });
  log.level = 'silent'; logTap.fn = undefined;
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ level: 40, walletId: w.id });
  expect(lines[0]).not.toMatch(/90\.00|100\.00|10\.00/); // no amounts in logs
  expect(divergenceCounter.value).toBe(n + 1);
  expect(await c.execute('select * from wallets where id = ?', [w.id])).toEqual(before);
  expect(await c.execute('select 1 from wallet_ledger_entries where wallet_id = ?', [w.id])).toHaveLength(1);
});

test('unknown Wallet is 404', async () => {
  expect((await reconcile(uuid())).status).toBe(404);
});

test('Reconciliation while parallel BETs run never reports a false Divergence', async () => {
  const w = await open('1000.00');
  const n = divergenceCounter.value;
  let running = true;
  const bets = Promise.all(Array.from({ length: 8 }, async () => { for (let i = 0; i < 15; i++) await placeBet(w.id, '1.00'); })).finally(() => (running = false));
  let checks = 0;
  while (running || checks < 5) {
    const body = (await (await reconcile(w.id)).json()) as any;
    expect(body.consistent).toBe(true);
    checks++;
  }
  await bets;
  const last = (await (await reconcile(w.id)).json()) as any;
  expect(last).toMatchObject({ consistent: true, checkedEntries: 121, storedBalance: { amount: '880.00' } });
  expect(divergenceCounter.value).toBe(n);
  await expectBalanceMatchesLedger(orm, w.id);
});
