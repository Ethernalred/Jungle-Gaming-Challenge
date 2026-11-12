import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { PendingReferenceWorker, MAX_ATTEMPTS } from '../../src/application/pending-reference-worker';
import { resolveReference } from '../../src/application/resolve-reference';
import { WagerTransactionRepository } from '../../src/application/wager-ports';
import { Clock } from '../../src/domain/clock';
import { IdGenerator } from '../../src/domain/id-generator';
import { MikroWagerTransactionRepository } from '../../src/infrastructure/persistence/wager-transaction.repository';
import { bodyOf, openWallet as openWalletRaw, startApp, submit } from '../support/app';
import { initOrm } from '../support/db';
import { expectBalanceMatchesLedger } from '../support/ledger';
import { dataOf, isolateQueues, makeConsumer, requested, send as sendToQueue, until } from '../support/queue';
setDefaultTimeout(60_000);

class TestClock extends Clock {
  t = new Date();
  now() { return this.t; }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
}

let app: Awaited<ReturnType<typeof startApp>>;
let dropQueues: () => Promise<void>;
let owner: MikroORM;
let repo: WagerTransactionRepository;
let ids: IdGenerator;
const clock = new TestClock();
// The DB is shared and holds leftover due rows from other suites: every worker here sees only Wallets this file opened.
const mine = new Set<string>();
const openWallet = async (...a: Parameters<typeof openWalletRaw>) => { const w = await openWalletRaw(...a); mine.add(w.walletId); return w; };
const scoped = (r: WagerTransactionRepository) => Object.assign(Object.create(r), {
  findDuePending: async (now: Date) => (await r.findDuePending(now, 1_000_000)).filter((t) => mine.has(t.walletId)),
}) as WagerTransactionRepository;
const worker = () => new PendingReferenceWorker(scoped(repo), clock, ids, undefined, 1000, 1000);
beforeAll(async () => {
  dropQueues = await isolateQueues();
  process.env.PENDING_REFERENCE_WORKER = 'off'; // tests drive the worker with an injected clock
  process.env.OUTBOX_PUBLISHER = 'off';
  app = await startApp();
  owner = await initOrm();
  repo = app.app.get(WagerTransactionRepository);
  ids = app.app.get(IdGenerator);
});
afterAll(async () => { await app.app.close(); await owner.close(); await dropQueues(); delete process.env.PENDING_REFERENCE_WORKER; delete process.env.OUTBOX_PUBLISHER; });

type W = { walletId: string; playerId: string };
const ext = (w: W, e: string) => `${w.walletId}:${e}`;
const send = async (w: W, kind: string, e: string, amount: string, ref?: string) => {
  const r = await submit(app.base, { ...bodyOf({ ...w, kind, amount, externalTransactionId: ext(w, e) }), ...(ref ? { referenceExternalTransactionId: ext(w, ref) } : {}) });
  return { status: r.status, json: await r.json() };
};
const row = async (w: W, e: string) => (await owner.em.execute('select * from wager_transactions where external_transaction_id = ?', [ext(w, e)]))[0];
const events = async (w: W, type: string) => (await owner.em.execute('select payload from outbox_events where aggregate_id = ? and event_type = ?', [w.walletId, type])).map((r: any) => r.payload);
const balance = async (w: W) => (await owner.em.execute('select balance::text b from wallets where id = ?', [w.walletId]))[0].b;
const catchUp = () => clock.advance(10 * 60_000); // past every backoff

test('a ROLLBACK delivered before its BET over HTTP stays PENDING_REFERENCE, is not due yet, then PROCESSED after the BET lands', async () => {
  const w = await openWallet(app.base, '100.00');
  expect((await send(w, 'ROLLBACK', 'rb', '10.00', 'bet')).json.status).toBe('PENDING_REFERENCE');
  clock.t = new Date();
  await worker().tick();
  expect(await row(w, 'rb')).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 0 }); // 2 s have not passed
  clock.advance(2500);
  await worker().tick(); // BET still missing: attempt 1 fails, backs off 4 s
  expect(await row(w, 'rb')).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
  clock.advance(1000);
  await worker().tick();
  expect(await row(w, 'rb')).toMatchObject({ reference_attempts: 1 }); // inside the backoff: untouched
  expect((await send(w, 'BET', 'bet', '10.00')).status).toBe(201);
  clock.advance(4000);
  await worker().tick();
  expect(await row(w, 'rb')).toMatchObject({ status: 'PROCESSED', failure_code: null });
  expect(await balance(w)).toBe('100.00'); // BET debited, ROLLBACK credited back
  expect(await events(w, 'WagerTransactionProcessed')).toHaveLength(3); // OPENING, BET, ROLLBACK
  await worker().tick(); // final: never picked again
  expect(await events(w, 'WagerTransactionProcessed')).toHaveLength(3);
  await expectBalanceMatchesLedger(owner, w.walletId);
});

test('the Reference never arrives: after 8 attempts (2 s x 2^n, about 8.5 min) REJECTED REFERENCE_NOT_FOUND with a Rejected event', async () => {
  const w = await openWallet(app.base, '50.00');
  await send(w, 'REFUND', 'rf', '5.00', 'ghost');
  clock.t = new Date();
  let total = 0;
  for (let n = 0; n < MAX_ATTEMPTS; n++) {
    clock.advance(n === 0 ? 2000 : 2000 * 2 ** n);
    total += n === 0 ? 2000 : 2000 * 2 ** n;
    await worker().tick();
  }
  expect(total).toBe(510_000);
  expect(await row(w, 'rf')).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_attempts: MAX_ATTEMPTS });
  const rej = await events(w, 'WagerTransactionRejected');
  expect(rej).toHaveLength(1);
  expect(rej[0].data.failureCode).toBe('REFERENCE_NOT_FOUND');
  expect(await balance(w)).toBe('50.00');
  await expectBalanceMatchesLedger(owner, w.walletId);
});

test('a Reference that was REJECTED resolves the pending row to REJECTED REFERENCE_NOT_PROCESSED', async () => {
  const w = await openWallet(app.base, '5.00');
  await send(w, 'ROLLBACK', 'rb', '10.00', 'big');
  expect((await send(w, 'BET', 'big', '10.00')).status).toBe(422); // INSUFFICIENT_FUNDS
  catchUp();
  await worker().tick();
  expect(await row(w, 'rb')).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_PROCESSED' });
});

test('a non-transient, non-business error stores FAILED INTERNAL_ERROR and the row is never retried', async () => {
  const w = await openWallet(app.base, '100.00');
  await send(w, 'ROLLBACK', 'rb', '10.00', 'bet');
  catchUp();
  const boom = new PendingReferenceWorker(scoped(repo), clock, ids, async (tx, ...rest) => { if (tx.state.walletId !== w.walletId) return resolveReference(tx, ...rest); throw new Error('boom'); }, 1000, 1000);
  await boom.tick();
  expect(await row(w, 'rb')).toMatchObject({ status: 'FAILED', failure_code: 'INTERNAL_ERROR' });
  await worker().tick();
  await expectBalanceMatchesLedger(owner, w.walletId);
});

test('two workers on separate connections process each row once', async () => {
  const second = await initOrm();
  try {
    const wallets: W[] = [];
    for (let i = 0; i < 8; i++) {
      const w = await openWallet(app.base, '100.00');
      await send(w, 'ROLLBACK', 'rb', '10.00', 'bet');
      await send(w, 'BET', 'bet', '10.00');
      wallets.push(w);
    }
    catchUp();
    const a = worker();
    const b = new PendingReferenceWorker(scoped(new MikroWagerTransactionRepository(second)), clock, ids, undefined, 1000, 1000);
    await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    for (const w of wallets) {
      expect(await row(w, 'rb')).toMatchObject({ status: 'PROCESSED' });
      expect(await events(w, 'WagerTransactionProcessed')).toHaveLength(3);
      expect(await balance(w)).toBe('100.00');
      expect(Number((await owner.em.execute('select count(*) n from wallet_ledger_entries where wallet_id = ?', [w.walletId]))[0].n)).toBe(3); // opening, BET, ROLLBACK once
      await expectBalanceMatchesLedger(owner, w.walletId);
    }
  } finally { await second.close(); }
});

test('a ROLLBACK delivered before its BET over the queue stays PENDING_REFERENCE, then PROCESSED after the BET lands', async () => {
  const w = await openWallet(app.base, '100.00');
  const c = await makeConsumer();
  const rowOf = async (e: string) => (await owner.em.execute('select * from wager_transactions where external_transaction_id = ?', [e]))[0];
  try {
    c.consumer.start();
    const bet = dataOf(w);
    const rb = dataOf(w, { kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId });
    await sendToQueue(requested(rb), w.walletId);
    expect(await until(async () => (await rowOf(rb.externalTransactionId))?.status === 'PENDING_REFERENCE')).toBe(true);
    clock.t = new Date();
    clock.advance(2500);
    await worker().tick(); // BET still missing: attempt 1 fails
    expect(await rowOf(rb.externalTransactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
    await sendToQueue(requested(bet), w.walletId);
    expect(await until(async () => (await rowOf(bet.externalTransactionId))?.status === 'PROCESSED')).toBe(true);
    catchUp();
    await worker().tick();
    expect(await rowOf(rb.externalTransactionId)).toMatchObject({ status: 'PROCESSED', failure_code: null });
    expect(await balance(w)).toBe('100.00');
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await c.close(); }
});

// Two instances that read the due list at the same clock time, then attempt in turn (the stale-list race, made deterministic).
const staleWorkers = async (second: MikroORM) => {
  const due = await scoped(repo).findDuePending(clock.now(), 1000);
  const stale = (r: WagerTransactionRepository) => Object.assign(Object.create(r), { findDuePending: async () => due }) as WagerTransactionRepository;
  return [new PendingReferenceWorker(stale(repo), clock, ids, undefined, 1000, 1000), new PendingReferenceWorker(stale(new MikroWagerTransactionRepository(second)), clock, ids, undefined, 1000, 1000)];
};

test('two instances holding the same stale due list attempt a row once, and follow the D27 schedule', async () => {
  const second = await initOrm();
  try {
    const w = await openWallet(app.base, '50.00');
    await send(w, 'REFUND', 'rf', '5.00', 'ghost');
    clock.t = new Date();
    for (let n = 0; n < MAX_ATTEMPTS; n++) {
      clock.advance(n === 0 ? 2000 : 2000 * 2 ** n);
      const before = await row(w, 'rf');
      const [a, b] = await staleWorkers(second);
      await a.tick();
      await b.tick();
      const after = await row(w, 'rf');
      expect(after.reference_attempts).toBe(n + 1);
      if (n + 1 < MAX_ATTEMPTS) {
        expect(new Date(after.next_attempt_at).getTime()).toBe(clock.now().getTime() + 2000 * 2 ** (n + 1)); // moved forward once
        clock.advance(2000 * 2 ** (n + 1) - 1); // just inside the backoff: nobody may attempt
        const [c, d] = await staleWorkers(second);
        await c.tick();
        await d.tick();
        expect((await row(w, 'rf')).reference_attempts).toBe(n + 1);
        clock.advance(-(2000 * 2 ** (n + 1) - 1));
      } else expect(after).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
      expect(before.reference_attempts).toBe(n);
    }
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await second.close(); }
});
