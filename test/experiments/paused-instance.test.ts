import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { Instance, startInstance } from '../support/cluster';
import { pinned } from '../support/pin';
import { initOrm } from '../support/db';
import { expectBalanceMatchesLedger } from '../support/ledger';
import { dataOf, isolateQueues, makeConsumer, requested, rowCount, send, until } from '../support/queue';

/**
 * A paused process is not a dead one. An instance frozen (SIGSTOP: think stop-the-world GC, a suspended VM, a container
 * throttled to zero) in the middle of its DB transaction keeps its TCP connection open, so PostgreSQL cannot tell it from
 * a slow one and keeps its Wallet lock. A killed one (SIGKILL) closes the socket and PostgreSQL rolls back at once.
 * Checks lock retention while a process is paused.
 *  - the pinned one (test/support/pin.ts) holds the limitation: nothing bounds how long a frozen instance blocks a Wallet (no
 *    idle_in_transaction_session_timeout or similar), so every other request on it gets 503 for as long as the pause lasts;
 *  - the passing one is the recovery guarantee that must hold: once the frozen instance dies, the Wallet is writable at
 *    once and its half-done queue message is redelivered and applied exactly once.
 */
setDefaultTimeout(120_000);
let app: Awaited<ReturnType<typeof startApp>>;
let owner: MikroORM;
let dropQueues: () => Promise<void>;
let frozen: Instance | undefined;
beforeAll(async () => {
  for (const k of ['QUEUE_CONSUMER', 'OUTBOX_PUBLISHER', 'PENDING_REFERENCE_WORKER']) process.env[k] = 'off';
  app = await startApp(); // HTTP only
  for (const k of ['QUEUE_CONSUMER', 'OUTBOX_PUBLISHER', 'PENDING_REFERENCE_WORKER']) delete process.env[k];
  owner = await initOrm();
});
// SIGKILL also ends a stopped process. Each test gets its own queues: a killed instance's in-flight message would
// otherwise be redelivered to the next test's instance, which would freeze on the wrong Wallet.
afterEach(async () => { await frozen?.stop('SIGKILL'); frozen = undefined; await dropQueues(); });
afterAll(async () => { await app.app.close(); await owner.close(); });

/** True when someone holds this Wallet's row lock (NOWAIT fails at once with 55P03 instead of queueing). */
const lockedByOther = async (walletId: string) => {
  try { await owner.em.fork().execute('select 1 from wallets where id = ? for update nowait', [walletId]); return false; } // autocommit: released at once
  catch (e: any) { if ((e.code ?? e.cause?.code) === '55P03') return true; throw e; }
};

/** A child instance that takes a queue message and freezes inside its DB transaction, Wallet lock held. */
async function freezeMidTransaction(w: { walletId: string; playerId: string }) {
  dropQueues = await isolateQueues();
  frozen = await startInstance({ QUEUE_FAULT: 'slow', OUTBOX_PUBLISHER: 'off', PENDING_REFERENCE_WORKER: 'off' });
  const msg = requested(dataOf(w));
  await send(msg, w.walletId);
  const out = `${tmpdir()}/junglegame-mi-${frozen.port}.out`;
  // the 'slow' hook gives a 1.5 s window inside the transaction: poll every 10 ms (until() polls every 100 ms)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await Bun.file(out).text().catch(() => '')).includes('CONSUMER_PROCESSING')) await Bun.sleep(10);
  process.kill(frozen.proc.pid, 'SIGSTOP');
  expect(await lockedByOther(w.walletId)).toBe(true); // the freeze landed inside the transaction, on this Wallet's lock
  return msg;
}

const win = process.platform === 'win32';
pinned('F9: a frozen instance stops blocking the Wallet within 10 s (it does not: the lock is held as long as the pause lasts)' + (win ? ' (needs POSIX signals: skipped on Windows)' : ''), async () => {
  const w = await openWallet(app.base, '100.00');
  await freezeMidTransaction(w); // asserts the freeze landed on this Wallet's lock; if not, the pin goes red (test/support/pin.ts)
  return w;
}, async (w) => {
  const body = bodyOf(w);
  expect(await until(async () => (await submit(app.base, body)).status === 201, 10_000)).toBe(true);
}, 60_000, { skip: win });

test.skipIf(win)('once the frozen instance dies, the Wallet is writable at once and its message is redelivered and applied exactly once' + (win ? ' (needs POSIX signals: skipped on Windows)' : ''), async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = await freezeMidTransaction(w);
  const body = bodyOf(w);
  expect((await submit(app.base, body)).status).toBe(503); // lock_timeout 2 s: "temporarily unavailable", never a wrong answer
  await frozen!.stop('SIGKILL');
  frozen = undefined;
  expect((await submit(app.base, body)).status).toBe(201); // same key: the 503 stored nothing
  const c = await makeConsumer({ visibilitySeconds: 3 });
  try {
    c.consumer.start(); // the message the frozen instance held comes back after its visibility timeout
    expect(await until(async () => (await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [msg.messageId])) === 1, 30_000)).toBe(true);
  } finally { await c.close(); }
  expect(await rowCount(owner, `select count(*) n from wager_transactions where wallet_id = ? and kind = 'BET'`, [w.walletId])).toBe(2);
  expect((await owner.em.execute('select balance::text b from wallets where id = ?', [w.walletId]))[0].b).toBe('80.00');
  await expectBalanceMatchesLedger(owner, w.walletId);
});
