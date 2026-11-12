import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { TransientError } from '../../src/domain/errors';
import { expectBalanceMatchesLedger } from '../support/ledger';
import { openWallet, startApp } from '../support/app';
import { initOrm } from '../support/db';
import { dataOf, isolateQueues, makeConsumer, requested, rowCount, send, takeFromDlq, until } from '../support/queue';

setDefaultTimeout(90_000);
let dropQueues: () => Promise<void>;
let owner: MikroORM;
let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { dropQueues = await isolateQueues(); owner = await initOrm(); app = await startApp(); });
afterAll(async () => { await app.app.close(); await owner.close(); await dropQueues(); });

const txCount = (walletId: string) => rowCount(owner, 'select count(*) n from wager_transactions where wallet_id = ? and kind <> \'OPENING\'', [walletId]);
const inboxHas = async (id: string) => (await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [id])) === 1;
const balance = async (walletId: string) => (await owner.em.execute('select balance::text b from wallets where id = ?', [walletId]))[0].b;

test('the same message delivered twice -> one effect', async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = requested(dataOf(w));
  const c = await makeConsumer();
  try {
    c.consumer.start();
    await send(msg, w.walletId);
    await send(msg, w.walletId); // redelivery: same messageId and payload
    expect(await until(async () => (await txCount(w.walletId)) === 1 && (await inboxHas(msg.messageId)))).toBe(true);
    await Bun.sleep(1500); // the second delivery is consumed too
    expect(await txCount(w.walletId)).toBe(1);
    expect(await balance(w.walletId)).toBe('90.00');
    expect(await rowCount(owner, 'select count(*) n from wallet_ledger_entries where wallet_id = ?', [w.walletId])).toBe(2); // OPENING credit + the BET debit
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await c.close(); }
});

test('a different messageId with the same Idempotency Key -> Replay, no second effect', async () => {
  const w = await openWallet(app.base, '100.00');
  const d = dataOf(w);
  const a = requested(d), b = requested(d);
  const c = await makeConsumer();
  try {
    c.consumer.start();
    await send(a, w.walletId);
    await send(b, w.walletId);
    expect(await until(async () => (await inboxHas(a.messageId)) && (await inboxHas(b.messageId)))).toBe(true);
    expect(await txCount(w.walletId)).toBe(1);
    expect(await balance(w.walletId)).toBe('90.00');
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await c.close(); }
});

test('malformed, OPENING and inbox hash mismatch go to the DLQ and change nothing', async () => {
  const w = await openWallet(app.base, '100.00');
  const c = await makeConsumer();
  try {
    c.consumer.start();
    const marker = `garbage-${Date.now()}`;
    await send(marker, w.walletId); // not JSON
    expect(await takeFromDlq(marker)).toBe(marker);

    const opening = requested(dataOf(w, { kind: 'OPENING' }));
    await send(opening, w.walletId);
    expect(await takeFromDlq(opening.messageId)).not.toBeNull();

    const first = requested(dataOf(w));
    await send(first, w.walletId);
    expect(await until(() => inboxHas(first.messageId))).toBe(true);
    const clash = { ...first, data: { ...first.data, money: { amount: '11.00', currency: 'BRL' } } }; // same messageId, other payload
    await send(clash, w.walletId);
    expect(await takeFromDlq(first.messageId)).not.toBeNull();

    const invalid = requested(dataOf(w, { money: { amount: 'abc', currency: 'BRL' } }));
    await send(invalid, w.walletId);
    expect(await takeFromDlq(invalid.messageId)).not.toBeNull();

    expect(await txCount(w.walletId)).toBe(1);
    expect(await balance(w.walletId)).toBe('90.00');
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await c.close(); }
});

test('a business outcome (Rejected) is stored and acked, not sent to the DLQ', async () => {
  const w = await openWallet(app.base, '5.00');
  const msg = requested(dataOf(w, { money: { amount: '50.00', currency: 'BRL' } })); // INSUFFICIENT_FUNDS
  const c = await makeConsumer();
  try {
    c.consumer.start();
    await send(msg, w.walletId);
    expect(await until(() => inboxHas(msg.messageId))).toBe(true);
    const [t] = await owner.em.execute('select status, failure_code from wager_transactions where wallet_id = ? and kind <> \'OPENING\'', [w.walletId]);
    expect(t).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await takeFromDlq(msg.messageId, 2000)).toBeNull();
  } finally { await c.close(); }
});

test('a transient DB outage is retried with backoff, then succeeds', async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = requested(dataOf(w));
  let failures = 2;
  const c = await makeConsumer({ visibilitySeconds: 5, backoffBaseSeconds: 1 }, (u) => ({
    execute: (i, hook) => { if (failures-- > 0) throw new TransientError('fault hook: DB down'); return u.execute(i, hook); },
  }));
  try {
    c.consumer.start();
    await send(msg, w.walletId);
    expect(await until(() => inboxHas(msg.messageId), 30_000)).toBe(true);
    expect(failures).toBeLessThan(0);
    expect(await txCount(w.walletId)).toBe(1);
    expect(await balance(w.walletId)).toBe('90.00');
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await c.close(); }
});

test('a transient error that repeats lands in the DLQ via maxReceiveCount = 5', async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = requested(dataOf(w));
  let calls = 0;
  const c = await makeConsumer({ backoffBaseSeconds: 0 }, () => ({ execute: async () => { calls++; throw new TransientError('always down'); } }));
  try {
    c.consumer.start();
    await send(msg, w.walletId);
    expect(await takeFromDlq(msg.messageId, 60_000)).not.toBeNull();
    expect(calls).toBe(5);
    expect(await txCount(w.walletId)).toBe(0);
  } finally { await c.close(); }
}, 90_000);

test('stop() waits the grace period, then gives the unfinished message back (visibility 0)', async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = requested(dataOf(w));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = false;
  const c = await makeConsumer({ graceMs: 300 }, () => ({ execute: async () => { started = true; await gate; throw new TransientError('never committed'); } }));
  try {
    await send(msg, w.walletId);
    c.consumer.start();
    expect(await until(async () => started)).toBe(true);
    const t0 = Date.now();
    await c.consumer.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    release();
    // visible again at once: a fresh consumer processes it
    const d = await makeConsumer();
    try {
      d.consumer.start();
      expect(await until(() => inboxHas(msg.messageId), 10_000)).toBe(true);
      expect(await txCount(w.walletId)).toBe(1);
      await expectBalanceMatchesLedger(owner, w.walletId);
    } finally { await d.close(); }
  } finally { release(); await c.close(); }
});
