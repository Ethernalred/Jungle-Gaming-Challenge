import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { v7 as uuid } from 'uuid';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { LockedWallet } from '../../src/application/wager-ports';
import { SystemClock } from '../../src/domain/clock';
import { UuidV7Generator } from '../../src/domain/id-generator';
import { MikroWagerTransactionRepository } from '../../src/infrastructure/persistence/wager-transaction.repository';
import { OutboxPublisher } from '../../src/infrastructure/sqs/outbox-publisher';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { collectEvents, drainDueOutbox, realSqs, eventTypes } from '../support/events';
import { expectBalanceMatchesLedger } from '../support/ledger';
import { initOrm } from '../support/db';
setDefaultTimeout(60_000);

let app: Awaited<ReturnType<typeof startApp>>;
let orm: MikroORM; // the app's restricted role (jungle_app)
let owner: MikroORM;
beforeAll(async () => {
  process.env.OUTBOX_PUBLISHER = 'off'; // these tests drive publishers themselves
  app = await startApp();
  orm = app.app.get(MikroORM);
  owner = await initOrm();
});
afterAll(async () => { await app.app.close(); await owner.close(); delete process.env.OUTBOX_PUBLISHER; });

const rows = (walletId: string) => owner.em.execute(
  'select event_type, payload, published_at, attempts, next_attempt_at from outbox_events where aggregate_id = ? order by seq', [walletId]);
const types = async (walletId: string) => (await rows(walletId)).map((r: any) => r.event_type);

test('each outcome writes its events: Processed (also LOSS), Balance changes only when the Balance moves, money as decimal strings', async () => {
  const { walletId, playerId } = await openWallet(app.base, '100.00');
  expect(await types(walletId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']); // OPENING
  const send = (b: object) => submit(app.base, bodyOf({ walletId, playerId, ...b }));

  expect((await send({ kind: 'BET', amount: '10.00' })).status).toBe(201);
  expect((await send({ kind: 'LOSS', amount: '0.00' })).status).toBe(201);
  expect((await send({ kind: 'BET', amount: '1000.00' })).status).toBe(422);
  const ghost = { ...bodyOf({ walletId, playerId, kind: 'REFUND', amount: '10.00' }), referenceExternalTransactionId: 'nope' };
  expect((await submit(app.base, ghost)).status).toBe(202);
  expect((await submit(app.base, ghost)).status).toBeLessThan(300); // Replay: no new events

  expect(await types(walletId)).toEqual([
    'WagerTransactionProcessed', 'WalletBalanceChanged', // OPENING
    'WagerTransactionProcessed', 'WalletBalanceChanged', // BET
    'WagerTransactionProcessed', // LOSS, no Balance change
    'WagerTransactionRejected', // INSUFFICIENT_FUNDS
    'WagerTransactionPendingReference',
  ]);
  const all = await rows(walletId);
  const bet = all[3].payload;
  expect(bet).toMatchObject({ eventType: 'WalletBalanceChanged', version: 1, aggregateId: walletId, data: { direction: 'DEBIT', money: { amount: '10.00', currency: 'BRL' }, balanceBefore: { amount: '100.00' }, balanceAfter: { amount: '90.00' }, walletVersion: 2 } });
  expect(all[5].payload.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  expect(typeof all[0].payload.occurredAt).toBe('string');
  await expectBalanceMatchesLedger(owner, walletId);
});

test('atomicity: a failure after the ledger write leaves no Wallet change, no ledger row, no Wager Transaction and no outbox row', async () => {
  const { walletId, playerId } = await openWallet(app.base, '100.00');
  const before = (await rows(walletId)).length;
  class FailingEmit extends MikroWagerTransactionRepository {
    override withWalletLocked<T>(id: string, fn: (l: LockedWallet) => Promise<T>) {
      return super.withWalletLocked(id, (l) => fn({ ...l, wallet: l.wallet, emit: async (ev) => { await l.emit(ev); throw new Error('boom after outbox write'); } }));
    }
  }
  const failing = new SubmitWagerTransaction(new FailingEmit(orm), new SystemClock(), new UuidV7Generator());
  const b = bodyOf({ walletId, playerId, kind: 'BET', amount: '10.00' });
  await expect(failing.execute({ ...b, idempotencyKey: `${b.providerId}:${b.externalTransactionId}` })).rejects.toThrow('boom');

  expect((await rows(walletId)).length).toBe(before);
  const [{ n }] = await owner.em.execute('select count(*)::int n from wager_transactions where wallet_id = ? and kind = ?', [walletId, 'BET']);
  expect(n).toBe(0);
  expect((await (await fetch(`${app.base}/wallets/${walletId}`)).json()).balance.amount).toBe('100.00');
  await expectBalanceMatchesLedger(owner, walletId); // only the OPENING entry
});

test('SQS unavailable: rows stay pending with growing backoff, then publish once SQS is back; the app role can claim and update them', async () => {
  expect(await drainDueOutbox(owner)).toBe(0); // else the dead publisher's batches are mostly other suites' rows and this row's retry times jitter
  const { walletId, playerId } = await openWallet(app.base, '50.00');
  await submit(app.base, bodyOf({ walletId, playerId, kind: 'BET', amount: '5.00' }));
  expect(await types(walletId)).toHaveLength(4);
  const [{ u }] = await orm.em.execute('select current_user u');
  expect(u).toBe('jungle_app');

  const dead = new OutboxPublisher(orm, new SQSClient({ endpoint: 'http://localhost:1', region: 'us-east-1', maxAttempts: 1, credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }),
    { pollMs: 20, backoffBaseMs: 100 });
  dead.start();
  const seen: number[] = []; // next_attempt_at each time the first row's attempts grow
  let last = 0;
  const deadline = Date.now() + 15_000;
  while (seen.length < 4 && Date.now() < deadline) {
    const [r] = await rows(walletId);
    if (r.attempts > last) { last = r.attempts; seen.push(new Date(r.next_attempt_at).getTime()); }
    await Bun.sleep(10);
  }
  await dead.stop();
  expect(seen.length).toBe(4);
  const gaps = seen.slice(1).map((t, i) => t - seen[i]);
  expect(gaps[2]).toBeGreaterThan(gaps[0]); // ~200ms, ~400ms, ~800ms
  expect((await rows(walletId)).every((r: any) => r.published_at === null)).toBe(true);

  const live = new OutboxPublisher(orm, realSqs, { pollMs: 20, backoffBaseMs: 100 });
  live.start();
  try {
    const got = await collectEvents([walletId], (g) => g.length >= 4);
    expect(new Set(got.map((e) => e.eventId)).size).toBe(4);
    expect(eventTypes(got)).toContain('WalletBalanceChanged');
  } finally { await live.stop(); }
  expect((await rows(walletId)).every((r: any) => r.published_at !== null)).toBe(true);
});
