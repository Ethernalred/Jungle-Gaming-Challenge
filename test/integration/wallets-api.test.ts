import 'reflect-metadata';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuid } from 'uuid';
import { AppModule } from '../../src/app.module';
import { expectBalanceMatchesLedger } from '../support/ledger';
setDefaultTimeout(60_000);

let app: INestApplication;
let base: string;
let orm: MikroORM;
const post = (body: unknown) => fetch(`${base}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const open = (amount: string, playerId = uuid(), currency = 'BRL') => post({ playerId, initialBalance: { amount, currency } });

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
  orm = app.get(MikroORM);
});
afterAll(() => app.close());

test('POST /wallets with a Balance: Wallet at version 1, OPENING Wager Transaction and CREDIT Ledger Entry', async () => {
  const playerId = uuid();
  const res = await open('1000.00', playerId);
  expect(res.status).toBe(201);
  const w = await res.json();
  expect(w).toEqual({ id: w.id, playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });

  const c = orm.em.getConnection();
  const [tx] = await c.execute('select * from wager_transactions where wallet_id = ?', [w.id]);
  expect(tx).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal', external_transaction_id: `opening:${w.id}`, idempotency_key: `opening:${w.id}`, round_id: null, game_id: null, balance_snapshot: '1000.00' });
  const [e] = await c.execute('select * from wallet_ledger_entries where wallet_id = ?', [w.id]);
  expect(e).toMatchObject({ direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00', transaction_id: tx.id });
  await expectBalanceMatchesLedger(orm, w.id);

  expect(await (await fetch(`${base}/wallets/${w.id}`)).json()).toEqual(w);
});

test('initial Balance 0.00: no OPENING row, no entry, version 1', async () => {
  const w = await (await open('0.00')).json();
  expect(w.version).toBe(1);
  const c = orm.em.getConnection();
  expect(await c.execute('select 1 from wager_transactions where wallet_id = ?', [w.id])).toHaveLength(0);
  expect(await c.execute('select 1 from wallet_ledger_entries where wallet_id = ?', [w.id])).toHaveLength(0);
  await expectBalanceMatchesLedger(orm, w.id);
});

test('duplicate Wallet (same Player and currency) is 409 WALLET_ALREADY_EXISTS; another currency is fine', async () => {
  const playerId = uuid();
  expect((await open('1.00', playerId)).status).toBe(201);
  const dup = await open('5.00', playerId);
  expect(dup.status).toBe(409);
  expect(await dup.json()).toEqual({ code: 'WALLET_ALREADY_EXISTS', message: expect.any(String) });
  expect((await open('1.00', playerId, 'USD')).status).toBe(201);
});

test('invalid payloads are 400 VALIDATION_ERROR', async () => {
  for (const body of [{}, { playerId: 'nope', initialBalance: { amount: '1.00', currency: 'BRL' } }, { playerId: uuid(), initialBalance: { amount: '1.5', currency: 'BRL' } },
    { playerId: uuid(), initialBalance: { amount: '-1.00', currency: 'BRL' } }, { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'br' } }]) {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  }
});

test('unknown Wallet is 404 NOT_FOUND on both GETs', async () => {
  for (const path of [`/wallets/${uuid()}`, `/wallets/${uuid()}/ledger`, '/wallets/not-a-uuid']) {
    const res = await fetch(base + path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
  }
});

test('ledger paging: opaque cursor stays stable when entries are added between pages; limit default 50, max 200', async () => {
  const w = await (await open('100.00')).json();
  const c = orm.em.getConnection();
  const addBet = async (i: number) => {
    const tx = uuid();
    const at = new Date(Date.now() + 1000 + i);
    await c.execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, player_id, wallet_id, round_id, game_id, kind, status, amount, currency, created_at, updated_at)
       values (?, 'p', ?, ?, 'h', ?, ?, 'r', 'g', 'BET', 'PROCESSED', '1.00', 'BRL', ?, ?)`, [tx, tx, tx, w.playerId, w.id, at, at]);
    await c.execute(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'DEBIT', '1.00', 'BRL', ?, ?, ?)`, [uuid(), w.id, tx, (100 - i).toFixed(2), (99 - i).toFixed(2), at]);
  };
  for (let i = 0; i < 4; i++) await addBet(i); // 5 entries including OPENING
  const page1 = await (await fetch(`${base}/wallets/${w.id}/ledger?limit=2`)).json();
  expect(page1.items).toHaveLength(2);
  expect(page1.items[0].direction).toBe('CREDIT');
  expect(page1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  await addBet(4); // arrives between pages
  const page2 = await (await fetch(`${base}/wallets/${w.id}/ledger?limit=2&cursor=${page1.nextCursor}`)).json();
  const page3 = await (await fetch(`${base}/wallets/${w.id}/ledger?limit=2&cursor=${page2.nextCursor}`)).json();
  const ids = [...page1.items, ...page2.items, ...page3.items].map((e: any) => e.id);
  expect(ids).toHaveLength(6);
  expect(new Set(ids).size).toBe(6);
  expect(page3.nextCursor).toBeNull();
  const all = await (await fetch(`${base}/wallets/${w.id}/ledger`)).json(); // default limit
  expect(all.items.map((e: any) => e.id)).toEqual(ids);

  for (const bad of ['limit=0', 'limit=201', 'limit=abc', 'cursor=garbage']) {
    expect((await fetch(`${base}/wallets/${w.id}/ledger?${bad}`)).status).toBe(400);
  }
  expect((await fetch(`${base}/wallets/${w.id}/ledger?limit=200`)).status).toBe(200);
});
