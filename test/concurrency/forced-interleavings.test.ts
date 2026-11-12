import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { holdWalletLock } from '../support/barrier';
import { queueDepth } from '../support/cluster';
import { initOrm } from '../support/db';
import { expectBalanceMatchesLedger } from '../support/ledger';
import { dataOf, isolateQueues, makeConsumer, requested, rowCount, send, until } from '../support/queue';

/**
 * Races that are made to happen instead of hoped for (test/support/barrier.ts). Each test first proves, from
 * pg_stat_activity, that the competing requests are queued on the same Wallet lock at the same moment, then releases them.
 * A pass therefore means "they really overlapped and the outcome was still right", not "they happened not to overlap".
 * Category: specification compliance (Requirements §8, §13), made deterministic.
 */
setDefaultTimeout(60_000);
let app: Awaited<ReturnType<typeof startApp>>;
let owner: MikroORM;
let dropQueues: () => Promise<void>;
beforeAll(async () => { dropQueues = await isolateQueues(); app = await startApp(); owner = await initOrm(); });
afterAll(async () => { await app.app.close(); await owner.close(); await dropQueues(); });

const balance = async (walletId: string) => (await owner.em.execute('select balance::text b from wallets where id = ?', [walletId]))[0].b;
const result = async (p: Promise<Response>) => { const r = await p; return { status: r.status, json: await r.json() }; };

test('§8: two 80.00 BETs on 100.00, proven queued on the Wallet lock together: one PROCESSED, one INSUFFICIENT_FUNDS', async () => {
  const w = await openWallet(app.base, '100.00');
  const lock = await holdWalletLock(owner, w.walletId);
  const inFlight = [0, 1].map(() => result(submit(app.base, bodyOf({ ...w, amount: '80.00' }))));
  expect(await lock.queued(2)).toBe(true); // both are inside withWalletLocked, blocked on SELECT ... FOR UPDATE
  await lock.release();
  const rs = await Promise.all(inFlight);
  expect(rs.map((r) => r.status).sort()).toEqual([201, 422]);
  expect(rs.find((r) => r.status === 422)!.json).toMatchObject({ code: 'INSUFFICIENT_FUNDS', balance: { amount: '20.00' } });
  expect(await balance(w.walletId)).toBe('20.00');
  await expectBalanceMatchesLedger(owner, w.walletId); // also: the rejection saw 20.00, a Balance that existed
});

test('five 30.00 BETs on 100.00, all queued: exactly 3 PROCESSED, 2 REJECTED that each saw 10.00', async () => {
  const w = await openWallet(app.base, '100.00');
  const lock = await holdWalletLock(owner, w.walletId);
  const inFlight = Array.from({ length: 5 }, () => result(submit(app.base, bodyOf({ ...w, amount: '30.00' }))));
  expect(await lock.queued(5)).toBe(true);
  await lock.release();
  const rs = await Promise.all(inFlight);
  expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
  const rejected = rs.filter((r) => r.status === 422);
  expect(rejected.map((r) => [r.json.code, r.json.balance.amount])).toEqual([['INSUFFICIENT_FUNDS', '10.00'], ['INSUFFICIENT_FUNDS', '10.00']]);
  // the successful BETs observed a strictly decreasing sequence: each one saw the previous one's effect (no lost update)
  expect(rs.filter((r) => r.status === 201).map((r) => r.json.balance.amount).sort()).toEqual(['10.00', '40.00', '70.00']);
  await expectBalanceMatchesLedger(owner, w.walletId);
});

test('the same BET 30 times, a full connection pool of copies queued on the lock: one debit, the rest Replays', async () => {
  const w = await openWallet(app.base, '100.00');
  const body = bodyOf({ ...w, amount: '10.00' });
  const lock = await holdWalletLock(owner, w.walletId);
  const inFlight = Array.from({ length: 30 }, () => result(submit(app.base, body)));
  expect(await lock.queued(8)).toBe(true); // the app pool has 10 connections; the other copies wait for one, then queue too
  await lock.release();
  const rs = await Promise.all(inFlight);
  expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
  expect(rs.filter((r) => r.status === 200 && r.json.idempotentReplay === true)).toHaveLength(29);
  expect(new Set(rs.map((r) => r.json.transactionId)).size).toBe(1);
  expect(await balance(w.walletId)).toBe('90.00');
  await expectBalanceMatchesLedger(owner, w.walletId);
});

/**
 * Two ingestion paths, one Idempotency-Key, at the same instant. The HTTP request and the queue message are both proven
 * queued on the lock before either runs. Whichever wins, there must be one Wager Transaction, one debit, an inbox row for
 * the message, and the message must be acked (not retried), because a Replay is a successful outcome.
 * Category: reliability hardening (the spec requires both paths to use the same use case, §10, but never races them).
 */
test('HTTP and the queue deliver the same Idempotency-Key at the same moment: one effect, the loser is a Replay, the message is acked', async () => {
  const w = await openWallet(app.base, '100.00');
  const d = dataOf(w, { money: { amount: '25.00', currency: 'BRL' } });
  const msg = requested(d);
  const c = await makeConsumer();
  const lock = await holdWalletLock(owner, w.walletId);
  try {
    c.consumer.start();
    await send(msg, w.walletId);
    expect(await lock.queued(1, 1800)).toBe(true); // the consumer first (its long poll takes up to 1 s)...
    const { idempotencyKey, ...httpBody } = d;
    const http = result(submit(app.base, httpBody, idempotencyKey as string));
    expect(await lock.queued(2)).toBe(true); // ...then HTTP; both wait well under lock_timeout (2 s)
    await lock.release();
    const r = await http;
    expect([200, 201]).toContain(r.status);
    expect(await until(async () => (await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [msg.messageId])) === 1)).toBe(true);
    expect(await rowCount(owner, `select count(*) n from wager_transactions where wallet_id = ? and kind = 'BET'`, [w.walletId])).toBe(1);
    expect(await balance(w.walletId)).toBe('75.00');
    expect(await until(async () => (await queueDepth()) === 0, 15_000)).toBe(true); // acked: not left in flight to be retried
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await lock.release(); await c.close(); }
});

/**
 * The visibility timeout expires while the first consumer is still inside its DB transaction, so SQS hands the same message
 * to a second consumer: two processes now work on one message at once (at-least-once in its rawest form). The first holds
 * the Wallet lock with its inbox row uncommitted; the second is proven queued on that lock; then the first commits.
 * Required outcome: one effect; the second sees the committed inbox row (InboxDuplicate) and acks.
 * Checks concurrent redelivery while the first delivery is still uncommitted.
 */
test('visibility timeout expires mid-transaction: a second consumer gets the same message, waits on the lock, then acks it as a duplicate', async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = requested(dataOf(w));
  let inside!: () => void;
  const isInside = new Promise<void>((r) => (inside = r));
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  // A: records its inbox row and holds the Wallet lock, then waits for the test before committing
  const a = await makeConsumer({ visibilitySeconds: 1 }, (u) => ({ execute: (i, hook) => u.execute(i, async () => { await hook?.(); inside(); await gate; }) }));
  let bCalls = 0;
  const b = await makeConsumer({ visibilitySeconds: 1 }, (u) => ({ execute: (i, hook) => { bCalls++; return u.execute(i, hook); } }));
  try {
    a.consumer.start();
    await send(msg, w.walletId);
    await isInside;
    b.consumer.start(); // after 1 s the message is visible again and B receives it
    const queuedBehindA = async () => (await owner.em.fork().execute(
      `select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%wallets%for update%'`))[0].n >= 1;
    expect(await until(queuedBehindA, 10_000)).toBe(true);
    expect(bCalls).toBe(1);
    finish(); // A commits; B gets the lock, its inbox insert conflicts with A's committed row: duplicate, ack
    expect(await until(async () => (await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [msg.messageId])) === 1)).toBe(true);
    expect(await until(async () => (await queueDepth()) === 0, 15_000)).toBe(true); // acked by B as a duplicate (A's stale receipt may fail)
    expect(await rowCount(owner, `select count(*) n from wager_transactions where wallet_id = ? and kind <> 'OPENING'`, [w.walletId])).toBe(1);
    expect(await balance(w.walletId)).toBe('90.00');
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { finish(); await a.close(); await b.close(); }
});
