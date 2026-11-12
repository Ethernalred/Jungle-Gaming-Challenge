import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { pinned } from '../support/pin';
import { initOrm } from '../support/db';
import { expectBalanceMatchesLedger } from '../support/ledger';
import { dataOf, isolateQueues, makeConsumer, requested, rowCount, send, takeFromDlq } from '../support/queue';

/**
 * Inputs that pass the domain's validation but hit a PostgreSQL limit. Category: reliability hardening.
 * Requirements §9 asks the API to tell an invalid payload (do not resend) from a transient failure (resend later).
 * Two layers: the "nothing half-applied" tests must always pass; the `test.failing` ones pin known status-code bugs. They pass while the bug exists and turn red once it is fixed.
 */
setDefaultTimeout(90_000);
let app: Awaited<ReturnType<typeof startApp>>;
let owner: MikroORM;
let dropQueues: () => Promise<void>;
beforeAll(async () => { dropQueues = await isolateQueues(); app = await startApp(); owner = await initOrm(); });
afterAll(async () => { await app.app.close(); await owner.close(); await dropQueues(); });

const NUMERIC_19_2_OVERFLOW = '100000000000000000.00'; // 18 integer digits; NUMERIC(19,2) holds 17
const NEAR_MAX = '99999999999999999.00';
const nonOpening = (walletId: string) => rowCount(owner, `select count(*) n from wager_transactions where wallet_id = ? and kind <> 'OPENING'`, [walletId]);

/** Payloads a Provider could really send; each is permanent: resending the same bytes can never succeed. */
const poison = (w: { walletId: string; playerId: string }) => ({
  'amount above NUMERIC(19,2)': bodyOf({ ...w, kind: 'WIN', amount: NUMERIC_19_2_OVERFLOW }),
  'WIN that pushes the Balance past NUMERIC(19,2)': bodyOf({ ...w, kind: 'WIN', amount: NEAR_MAX }),
  'NUL character in roundId': { ...bodyOf(w), roundId: 'round\u0000' },
  'externalTransactionId of 3000 random characters': bodyOf({ ...w, externalTransactionId: random(3000) }),
  'providerId of 9000 random characters': { ...bodyOf(w), providerId: random(9000) },
});
/** Incompressible: PostgreSQL compresses long values before indexing, so 'xxxx…' would slip under the limit. */
const random = (n: number) => randomBytes(n).toString('base64').slice(0, n);

test('poison payloads: whatever the status, nothing is half-applied and the Wallet stays consistent', async () => {
  const w = await openWallet(app.base, '100.00');
  for (const [name, body] of Object.entries(poison(w))) {
    const r = await submit(app.base, body);
    expect([name, r.status < 300]).toEqual([name, false]);
  }
  expect(await nonOpening(w.walletId)).toBe(0);
  expect((await (await fetch(`${app.base}/wallets/${w.walletId}`)).json()).balance.amount).toBe('100.00');
  await expectBalanceMatchesLedger(owner, w.walletId);
});

// F1: NUMERIC overflow (SQLSTATE 22003) is not translated: 500 INTERNAL_ERROR. Wanted: a 4xx the Provider will not retry.
// pinned(): setup (open a Wallet, get a response) must succeed; only the status assertion may fail (test/support/pin.ts).
const respond = (body: (w: { walletId: string; playerId: string }) => Record<string, unknown>, key?: string) => async () => {
  const w = await openWallet(app.base, '100.00');
  return submit(app.base, body(w), key);
};
const is4xx = (r: Response) => { expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500); };

pinned('F1: an amount the database cannot hold is a 4xx, not 500', respond((w) => poison(w)['amount above NUMERIC(19,2)']), is4xx);
pinned('F1: a WIN that would overflow the Balance column is a 4xx (a business rejection or validation), not 500',
  respond((w) => poison(w)['WIN that pushes the Balance past NUMERIC(19,2)']), is4xx);

// F2: PostgreSQL refuses \u0000 in text with SQLSTATE 08P01, and the repository's translate() treats class 08 as a
// connection failure: 503 TEMPORARILY_UNAVAILABLE + Retry-After: 1. A Provider that obeys Retry-After loops forever.
pinned('F2: a NUL character is 400 VALIDATION_ERROR, not 503 "retry later"', respond((w) => poison(w)['NUL character in roundId']), (r) => {
  expect(r.status).toBe(400);
  expect(r.headers.get('retry-after')).toBeNull();
});

// F3: identifiers have no length limit; past about 2.7 kB the unique index refuses the row (SQLSTATE 54000,
// "index row size exceeds btree maximum 2704"), untranslated: 500. The Idempotency-Key header hits the same index.
pinned('F3: an identifier longer than the unique index allows is 400, not 500',
  respond((w) => poison(w)['externalTransactionId of 3000 random characters']), (r) => expect(r.status).toBe(400));
pinned('F3: an Idempotency-Key longer than the unique index allows is 400, not 500', respond((w) => bodyOf(w), random(4000)), (r) => expect(r.status).toBe(400));

// F4: body-parser's 100 kB limit throws PayloadTooLargeError, which is not an HttpException, so the catch-all filter answers 500.
pinned('F4: a body over the size limit is 413, not 500', respond((w) => ({ ...bodyOf(w), padding: random(200_000) })), (r) => expect(r.status).toBe(413));

// Same bug on the queue: a permanent error is classified transient, so it is processed maxReceiveCount (5) times
// with backoff before the redrive policy moves it. It does reach the DLQ, so nothing is lost; it is slow and noisy.
test('queue: a poison message ends in the DLQ and changes nothing', async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = requested(dataOf(w, { kind: 'WIN', money: { amount: NUMERIC_19_2_OVERFLOW, currency: 'BRL' } }));
  const c = await makeConsumer({ backoffBaseSeconds: 0 });
  try {
    c.consumer.start();
    await send(msg, w.walletId);
    expect(await takeFromDlq(msg.messageId, 60_000)).not.toBeNull();
    expect(await nonOpening(w.walletId)).toBe(0);
    expect(await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [msg.messageId])).toBe(0);
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await c.close(); }
});

pinned('F1/F2 on the queue: a poison message goes to the DLQ on the first attempt, not after 5 transient retries', async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = requested(dataOf(w, { kind: 'WIN', money: { amount: NUMERIC_19_2_OVERFLOW, currency: 'BRL' } }));
  let calls = 0;
  const c = await makeConsumer({ backoffBaseSeconds: 0 }, (u) => ({ execute: (i, hook) => { calls++; return u.execute(i, hook); } }));
  try {
    c.consumer.start();
    await send(msg, w.walletId);
    expect(await takeFromDlq(msg.messageId, 60_000)).not.toBeNull(); // setup: it did reach the DLQ
  } finally { await c.close(); }
  return calls;
}, (calls) => expect(calls).toBe(1));
