import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuid } from 'uuid';
import { TransientError } from '../../src/domain/errors';
import { log, logTap } from '../../src/infrastructure/log';
import { expectBalanceMatchesLedger } from '../support/ledger';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { initOrm } from '../support/db';
import { dataOf, isolateQueues, makeConsumer, requested, rowCount, send, takeFromDlq, until } from '../support/queue';

setDefaultTimeout(120_000);
let dropQueues: () => Promise<void>;
let owner: MikroORM;
let app: Awaited<ReturnType<typeof startApp>>;
const lines: string[] = [];
beforeAll(async () => {
  process.env.OUTBOX_PUBLISHER = 'off'; process.env.PENDING_REFERENCE_WORKER = 'off'; // the outbox keeps its rows, so lag is observable
  dropQueues = await isolateQueues(); owner = await initOrm(); app = await startApp();
  log.level = 'info'; logTap.fn = (l) => lines.push(l);
});
afterAll(async () => {
  logTap.fn = undefined; delete process.env.OUTBOX_PUBLISHER; delete process.env.PENDING_REFERENCE_WORKER;
  await app.app.close(); await owner.close(); await dropQueues();
});

const scrape = async () => (await fetch(`${app.base}/metrics`)).text();
/** Sum of the samples called `name` whose labels contain `label` (e.g. 'status="PROCESSED"'). */
const val = (text: string, name: string, label = '') =>
  text.split('\n').filter((l) => (l.startsWith(`${name} `) || l.startsWith(`${name}{`)) && l.includes(label)).reduce((s, l) => s + Number(l.split(' ').at(-1)), 0);
const outboxPayloads = async (walletId: string) => (await owner.em.execute('select payload from outbox_events where aggregate_id = ? order by seq', [walletId])).map((r: any) => r.payload);

test('counters move after a known scenario; events and logs carry the correlationId', async () => {
  const before = await scrape();
  const w = await openWallet(app.base, '100.00');
  const http = bodyOf(w);

  // HTTP: PROCESSED, Replay (duplicate), REJECTED (INSUFFICIENT_FUNDS)
  const post = (b: any, corr?: string) => fetch(`${app.base}/wagering/transactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `${b.providerId}:${b.externalTransactionId}`, ...(corr ? { 'x-correlation-id': corr } : {}) }, body: JSON.stringify(b) });
  const r1 = await post(http, 'corr-http-1');
  expect(r1.status).toBe(201);
  expect(r1.headers.get('x-correlation-id')).toBe('corr-http-1');
  expect((await post(http, 'corr-http-2')).status).toBe(200);
  const rej = await post(bodyOf({ ...w, amount: '500.00' }));
  expect(rej.status).toBe(422);
  expect(rej.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/); // generated when absent

  // Queue: processed, delivered twice (inbox duplicate), a transient retry, a malformed message to the DLQ
  const msg = { ...requested(dataOf(w)), correlationId: 'corr-q-1' };
  let failures = 1;
  const c = await makeConsumer({ visibilitySeconds: 5, backoffBaseSeconds: 1 }, (u) => ({
    execute: (i, hook) => { if (failures-- > 0) throw new TransientError('fault hook'); return u.execute(i, hook); },
  }));
  try {
    c.consumer.start();
    await send(msg, w.walletId);
    expect(await until(async () => (await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [msg.messageId])) === 1, 30_000)).toBe(true);
    await send(msg, w.walletId); // inbox duplicate
    const bad = `garbage-${Date.now()}`;
    await send(bad, w.walletId);
    expect(await takeFromDlq(bad)).not.toBeNull();
    expect(await until(async () => val(await scrape(), 'duplicates_detected_total', 'source="inbox"') - val(before, 'duplicates_detected_total', 'source="inbox"') >= 1)).toBe(true);
  } finally { await c.close(); }

  // lock conflict: another connection holds the Wallet row past the 2 s lock_timeout
  const holder = owner.em.fork().transactional(async (em) => { await em.execute('select 1 from wallets where id = ? for update', [w.walletId]); await Bun.sleep(3000); });
  await Bun.sleep(300);
  expect((await submit(app.base, bodyOf(w))).status).toBe(503);
  await holder;

  // Divergence
  await owner.em.execute("update wallets set balance = balance - 1 where id = ?", [w.walletId]);
  await fetch(`${app.base}/wallets/${w.walletId}/reconciliation`, { method: 'POST' });
  await owner.em.execute("update wallets set balance = balance + 1 where id = ?", [w.walletId]);

  // outbox lag: a stuck row (not due for 10 min, so no publisher touches it) created 60 s ago; other processes may be publishing the app's own rows
  const stuck = uuid();
  await owner.em.execute(`insert into outbox_events (id, aggregate_id, event_type, payload, created_at, next_attempt_at) values (?, ?, 'Probe', '{}', now() - interval '60 seconds', now() + interval '10 minutes')`, [stuck, w.walletId]);
  const after = await scrape();
  await owner.em.execute('delete from outbox_events where id = ?', [stuck]);
  expect(val(after, 'outbox_lag_seconds')).toBeGreaterThanOrEqual(59);
  const d = (name: string, label = '') => val(after, name, label) - val(before, name, label);
  expect(d('wager_transactions_total', 'status="PROCESSED"')).toBe(2); // HTTP + queue
  expect(d('wager_transactions_total', 'status="REJECTED"')).toBe(1);
  expect(d('duplicates_detected_total', 'source="replay"')).toBe(1);
  expect(d('duplicates_detected_total', 'source="inbox"')).toBe(1);
  expect(d('retries_total', 'source="queue"')).toBe(1);
  expect(d('dlq_messages_total')).toBe(1);
  expect(d('lock_conflicts_total')).toBe(1);
  expect(d('reconciliation_divergences_total')).toBe(1);
  expect(d('processing_duration_seconds_count')).toBeGreaterThanOrEqual(4);

  // Events: the request's correlationId; causationId is the SQS messageId for queue input
  const events = (await outboxPayloads(w.walletId)).filter((e: any) => e.eventType !== undefined);
  const http1 = events.filter((e: any) => e.data.transactionId === (events.find((x: any) => x.correlationId === 'corr-http-1')?.data.transactionId));
  expect(http1.length).toBe(2); // Processed + BalanceChanged
  expect(http1.every((e: any) => e.correlationId === 'corr-http-1')).toBe(true);
  const q = events.filter((e: any) => e.correlationId === 'corr-q-1');
  expect(q.map((e: any) => e.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  expect(q.every((e: any) => e.causationId === msg.messageId)).toBe(true);

  // Logs: traceable by correlationId, with ids, and no amounts
  const parsed = lines.map((l) => JSON.parse(l));
  const httpLog = parsed.find((l) => l.correlationId === 'corr-http-1' && l.transactionId);
  expect(httpLog).toMatchObject({ walletId: w.walletId, providerId: 'prov-a' });
  expect(parsed.find((l) => l.correlationId === 'corr-q-1' && l.messageId === msg.messageId && l.transactionId)).toBeTruthy();
  const text = lines.join('');
  expect(text).not.toMatch(/"(amount|money|balance)[A-Za-z]*":"?\d|10\.00|100\.00|500\.00/);
  expect(text).not.toContain('"payload"');
  await expectBalanceMatchesLedger(owner, w.walletId);
});
