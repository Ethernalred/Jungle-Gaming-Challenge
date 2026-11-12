import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuid } from 'uuid';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { expectBalanceMatchesLedger } from '../support/ledger';
setDefaultTimeout(60_000);

let app: INestApplication;
let base: string;
let orm: MikroORM;
beforeAll(async () => { ({ app, base } = await startApp()); orm = app.get(MikroORM); });
afterAll(() => app.close());

const balanceOf = async (id: string) => (await (await fetch(`${base}/wallets/${id}`)).json()).balance.amount;
const entries = async (walletId: string) => orm.em.getConnection().execute('select * from wallet_ledger_entries where wallet_id = ? and direction != ? order by created_at', [walletId, 'x']);
const rowsFor = (walletId: string) => orm.em.getConnection().execute("select * from wager_transactions where wallet_id = ? and kind <> 'OPENING'", [walletId]);

test('BET debits: 201, Balance, Ledger Entry and balance_snapshot; Replay returns 200 with idempotentReplay and the same snapshot', async () => {
  const w = await openWallet(base, '100.00');
  const body = bodyOf({ ...w, amount: '25.00' });
  const res = await submit(base, body);
  expect(res.status).toBe(201);
  const first = await res.json();
  expect(first).toEqual({ transactionId: first.transactionId, status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });

  const win = await submit(base, bodyOf({ ...w, kind: 'WIN', amount: '5.00' })); // moves Balance on after the BET
  expect(win.status).toBe(201);

  const replay = await submit(base, body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...first, idempotentReplay: true }); // snapshot 75.00, not the current 80.00

  expect(await balanceOf(w.walletId)).toBe('80.00');
  const [bet] = await orm.em.getConnection().execute("select * from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.walletId]);
  expect(bet).toMatchObject({ amount: '25.00', balance_before: '100.00', balance_after: '75.00', transaction_id: first.transactionId });
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('WIN credits; LOSS is PROCESSED with no Ledger Entry and no version change (also LOSS 0.00)', async () => {
  const w = await openWallet(base, '10.00');
  expect((await submit(base, bodyOf({ ...w, kind: 'WIN', amount: '15.50' }))).status).toBe(201);
  const v = async () => (await (await fetch(`${base}/wallets/${w.walletId}`)).json()).version;
  expect(await v()).toBe(2);
  for (const amount of ['7.00', '0.00']) {
    const res = await submit(base, bodyOf({ ...w, kind: 'LOSS', amount }));
    expect(res.status).toBe(201);
    expect((await res.json()).balance.amount).toBe('25.50');
  }
  expect(await v()).toBe(2);
  expect(await rowsFor(w.walletId)).toHaveLength(3);
  expect(await entries(w.walletId)).toHaveLength(2); // OPENING + WIN
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('BET without enough Balance: stored REJECTED INSUFFICIENT_FUNDS, 422, no Ledger Entry; Replay is 422 again', async () => {
  const w = await openWallet(base, '5.00');
  const body = bodyOf({ ...w, amount: '5.01' });
  const res = await submit(base, body);
  expect(res.status).toBe(422);
  const j = await res.json();
  expect(j).toMatchObject({ code: 'INSUFFICIENT_FUNDS', status: 'REJECTED', balance: { amount: '5.00', currency: 'BRL' }, idempotentReplay: false });
  const [row] = await rowsFor(w.walletId);
  expect(row).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', balance_snapshot: '5.00' });
  const again = await submit(base, body);
  expect(again.status).toBe(422);
  expect(await again.json()).toMatchObject({ code: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
  expect(await entries(w.walletId)).toHaveLength(1);
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('currency mismatch: stored REJECTED CURRENCY_MISMATCH, 422, balance reported in the Wallet currency', async () => {
  const w = await openWallet(base, '50.00');
  const res = await submit(base, bodyOf({ ...w, currency: 'USD' }));
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ code: 'CURRENCY_MISMATCH', status: 'REJECTED', balance: { amount: '50.00', currency: 'BRL' } });
  expect((await rowsFor(w.walletId))[0]).toMatchObject({ status: 'REJECTED', failure_code: 'CURRENCY_MISMATCH' });
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('Wallet not found or player mismatch: 422 and nothing stored (D16)', async () => {
  const w = await openWallet(base, '50.00');
  const ghost = bodyOf({ playerId: w.playerId, walletId: uuid() });
  const r1 = await submit(base, ghost);
  expect(r1.status).toBe(422);
  expect(await r1.json()).toEqual({ code: 'WALLET_NOT_FOUND', message: expect.any(String) });
  const other = bodyOf({ playerId: uuid(), walletId: w.walletId });
  const r2 = await submit(base, other);
  expect(r2.status).toBe(422);
  expect((await r2.json()).code).toBe('WALLET_PLAYER_MISMATCH');
  const stored = await orm.em.getConnection().execute('select 1 from wager_transactions where external_transaction_id in (?, ?)', [ghost.externalTransactionId, other.externalTransactionId]);
  expect(stored).toHaveLength(0);
});

test('same key with a different payload: 409 IDEMPOTENCY_CONFLICT; same external id under another key: 409 EXTERNAL_ID_CONFLICT', async () => {
  const w = await openWallet(base, '100.00');
  const body = bodyOf({ ...w, amount: '10.00' });
  const k1 = uuid();
  expect((await submit(base, body, k1)).status).toBe(201);
  const diff = await submit(base, { ...body, money: { amount: '11.00', currency: 'BRL' } }, k1);
  expect(diff.status).toBe(409);
  expect(await diff.json()).toEqual({ code: 'IDEMPOTENCY_CONFLICT', message: expect.any(String) });
  const otherKey = await submit(base, body, uuid());
  expect(otherKey.status).toBe(409);
  expect((await otherKey.json()).code).toBe('EXTERNAL_ID_CONFLICT');
  expect(await balanceOf(w.walletId)).toBe('90.00');
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('validation: missing header, OPENING, bad amount, bad ids, and a REFUND without Reference are 400 VALIDATION_ERROR', async () => {
  const w = await openWallet(base, '10.00');
  const ok = bodyOf(w);
  const cases: [Record<string, unknown>, string | null][] = [
    [ok, null], // no Idempotency-Key
    [{ ...ok, kind: 'OPENING' }, 'a'],
    [{ ...ok, kind: 'NOPE' }, 'a'],
    [{ ...ok, money: { amount: '1', currency: 'BRL' } }, 'a'],
    [{ ...ok, money: { amount: '0.00', currency: 'BRL' } }, 'a'],
    [{ ...ok, money: { amount: '-1.00', currency: 'BRL' } }, 'a'],
    [{ ...ok, walletId: 'nope' }, 'a'],
    [{ ...ok, roundId: undefined }, 'a'],
    [{ ...ok, kind: 'REFUND' }, 'a'],
  ];
  for (const [b, key] of cases) {
    const res = await submit(base, b, key);
    expect([res.status, (await res.json()).code]).toEqual([400, 'VALIDATION_ERROR']);
  }
  expect(await rowsFor(w.walletId)).toHaveLength(0);
});

test('GET by internal id and by (providerId, externalTransactionId); unknown is 404 NOT_FOUND', async () => {
  const w = await openWallet(base, '10.00');
  const body = bodyOf({ ...w, amount: '3.00' });
  const { transactionId } = await (await submit(base, body)).json();
  const a = await (await fetch(`${base}/wagering/transactions/${transactionId}`)).json();
  const b = await (await fetch(`${base}/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`)).json();
  expect(a).toEqual(b);
  expect(a).toMatchObject({ transactionId, status: 'PROCESSED', kind: 'BET', money: { amount: '3.00', currency: 'BRL' }, balance: { amount: '7.00', currency: 'BRL' } });
  for (const url of [`/wagering/transactions/${uuid()}`, '/wagering/transactions/nope', `/providers/x/wagering/transactions/${uuid()}`]) {
    const res = await fetch(`${base}${url}`);
    expect([res.status, (await res.json()).code]).toEqual([404, 'NOT_FOUND']);
  }
});

test('a Wallet lock held past lock_timeout is 503 TEMPORARILY_UNAVAILABLE with Retry-After; nothing stored', async () => {
  const w = await openWallet(base, '10.00');
  const holder = orm.em.fork();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const tx = holder.transactional(async (em) => {
    await em.execute('select 1 from wallets where id = ? for update', [w.walletId]);
    locked();
    await held;
  });
  await isLocked;
  const body = bodyOf(w);
  const res = await submit(base, body);
  release();
  await tx;
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('1');
  expect((await res.json()).code).toBe('TEMPORARILY_UNAVAILABLE');
  expect(await rowsFor(w.walletId)).toHaveLength(0);
  expect((await submit(base, body)).status).toBe(201); // resend works once the lock is free
  await expectBalanceMatchesLedger(orm, w.walletId);
});
