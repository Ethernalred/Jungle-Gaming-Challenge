import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { initOrm } from '../support/db';
import { collectEvents } from '../support/events';
import { expectBalanceMatchesLedger } from '../support/ledger';
import { dataOf, isolateQueues, makeConsumer, requested, rowCount, send, until } from '../support/queue';

/**
 * Failures placed exactly at COMMIT, with no hook in the application: the test installs a temporary DEFERRABLE INITIALLY
 * DEFERRED constraint trigger on wallet_ledger_entries, scoped to one Wallet. A deferred trigger runs when the transaction
 * commits, after every write (Wager Transaction, Ledger Entry, Wallet update, outbox rows, inbox row) is already done.
 * So the failure lands on the one boundary that matters for atomicity: "all written, nothing committed".
 * Checks specification compliance for atomicity (Requirements sections 11 and 13).
 */
setDefaultTimeout(90_000);
let app: Awaited<ReturnType<typeof startApp>>;
let owner: MikroORM;
let dropQueues: () => Promise<void>;
beforeAll(async () => { dropQueues = await isolateQueues(); app = await startApp(); owner = await initOrm(); });
afterAll(async () => { await app.app.close(); await owner.close(); await dropQueues(); });

/** Installs the trigger for one Wallet; `action` is PL/pgSQL run at commit. Returns the uninstaller. */
async function atCommit(walletId: string, action: string) {
  const name = `test_at_commit_${walletId.replaceAll('-', '')}`;
  await owner.em.execute(`create function ${name}() returns trigger language plpgsql as $$
    begin if new.wallet_id = '${walletId}' then ${action} end if; return null; end $$`);
  await owner.em.execute(`create constraint trigger ${name} after insert on wallet_ledger_entries deferrable initially deferred
    for each row execute function ${name}()`);
  return async () => {
    await owner.em.execute(`drop trigger if exists ${name} on wallet_ledger_entries`);
    await owner.em.execute(`drop function if exists ${name}()`);
  };
}
const effects = async (walletId: string) => ({
  wagers: await rowCount(owner, `select count(*) n from wager_transactions where wallet_id = ? and kind <> 'OPENING'`, [walletId]),
  entries: await rowCount(owner, 'select count(*) n from wallet_ledger_entries where wallet_id = ?', [walletId]),
  outbox: await rowCount(owner, 'select count(*) n from outbox_events where aggregate_id = ?', [walletId]),
  balance: (await owner.em.execute('select balance::text b from wallets where id = ?', [walletId]))[0].b,
});

test('HTTP: COMMIT fails after every write: nothing persists (no Wager Transaction, entry, Balance change or event); the resend succeeds once', async () => {
  const w = await openWallet(app.base, '100.00');
  const before = await effects(w.walletId);
  const body = bodyOf({ ...w, amount: '30.00' });
  const uninstall = await atCommit(w.walletId, `raise exception 'injected failure at commit';`);
  try {
    const r = await submit(app.base, body);
    expect(r.status).toBeGreaterThanOrEqual(500); // an unknown DB error: 500. Not stored, so not a business outcome
  } finally { await uninstall(); }
  expect(await effects(w.walletId)).toEqual(before);
  // and no event about it left the building (§5.4: never publish before commit). The outbox rows above are only half of
  // that claim: an implementation that also sent straight to SQS inside the transaction would pass the row check.
  const events = await collectEvents([w.walletId], () => false, 3000); // proving a negative needs a wait; 6 publisher polls
  expect(events.filter((e) => e.data?.kind === 'BET' || e.data?.direction === 'DEBIT')).toEqual([]);
  expect((await submit(app.base, body)).status).toBe(201); // same key: a first attempt, not a Replay
  expect((await submit(app.base, body)).status).toBe(200);
  expect((await effects(w.walletId)).balance).toBe('70.00');
  await expectBalanceMatchesLedger(owner, w.walletId);
});

test('queue: COMMIT fails after the inbox row and every write: the message is retried, not lost and not acked; once commits work it applies exactly once', async () => {
  const w = await openWallet(app.base, '100.00');
  const before = await effects(w.walletId);
  const msg = requested(dataOf(w, { money: { amount: '30.00', currency: 'BRL' } }));
  const uninstall = await atCommit(w.walletId, `raise exception 'injected failure at commit';`);
  let failures = 0;
  const c = await makeConsumer({ visibilitySeconds: 2, backoffBaseSeconds: 1 }, (u) => ({ execute: (i, hook) => u.execute(i, hook).catch((e) => { failures++; throw e; }) }));
  try {
    c.consumer.start();
    await send(msg, w.walletId);
    expect(await until(async () => failures >= 2, 30_000)).toBe(true); // failed, came back, failed again: retried, not acked
    expect(await effects(w.walletId)).toEqual(before);
    expect(await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [msg.messageId])).toBe(0); // rolled back with the rest
    await uninstall();
    expect(await until(async () => (await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [msg.messageId])) === 1, 30_000)).toBe(true);
    expect((await effects(w.walletId)).balance).toBe('70.00');
    expect((await effects(w.walletId)).wagers).toBe(1);
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await uninstall(); await c.close(); }
});

/**
 * The connection dies while the transaction sits at COMMIT holding the Wallet lock (the trigger sleeps; the test kills
 * the backend with pg_terminate_backend, as a DB failover or network cut would). The client cannot know whether the
 * commit happened, so the answer must tell it to resend (503), the resend must not double-apply, and the Wallet lock
 * must be free again at once (PostgreSQL rolls back and releases locks when a backend dies).
 */
test('the DB connection is killed at COMMIT while holding the Wallet lock: 503, nothing applied, the lock is released, the resend applies once', async () => {
  const w = await openWallet(app.base, '100.00');
  const before = await effects(w.walletId);
  const body = bodyOf({ ...w, amount: '30.00' });
  const uninstall = await atCommit(w.walletId, 'perform pg_sleep(30);');
  try {
    const pending = submit(app.base, body);
    const sleeper = async () => (await owner.em.fork().execute(`select pid from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep' and query ilike 'commit%'`))[0]?.pid;
    expect(await until(async () => !!(await sleeper()), 10_000)).toBe(true);
    await owner.em.fork().execute('select pg_terminate_backend(?)', [await sleeper()]);
    const r = await pending;
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('1');
  } finally { await uninstall(); }
  expect(await effects(w.walletId)).toEqual(before);
  const t0 = Date.now();
  expect((await submit(app.base, body)).status).toBe(201);
  expect(Date.now() - t0).toBeLessThan(1500); // no lock left behind (lock_timeout would make this 2 s and a 503)
  await expectBalanceMatchesLedger(owner, w.walletId);
});

/**
 * §5.6 forbids a lock shared by all Wallets. Black-box check: freeze one Wallet's transaction at COMMIT (it holds whatever
 * locks the implementation takes), then write to a different Wallet. With per-Wallet locking it completes at once; with
 * any global lock (a mutex, an advisory lock, a table lock) it waits behind the frozen one and times out.
 */
test('§5.6 no global lock: while one Wallet\'s transaction is stuck at COMMIT, another Wallet is written at once', async () => {
  const stuck = await openWallet(app.base, '100.00');
  const other = await openWallet(app.base, '100.00');
  const uninstall = await atCommit(stuck.walletId, 'perform pg_sleep(4);');
  try {
    const slow = submit(app.base, bodyOf({ ...stuck, amount: '10.00' }));
    expect(await until(async () => (await owner.em.fork().execute(`select count(*)::int n from pg_stat_activity
      where datname = current_database() and wait_event = 'PgSleep' and query ilike 'commit%'`))[0].n >= 1, 10_000)).toBe(true);
    const t0 = Date.now();
    expect((await submit(app.base, bodyOf({ ...other, amount: '10.00' }))).status).toBe(201); // a global DB lock: 503 after lock_timeout
    expect(Date.now() - t0).toBeLessThan(2000); // a global lock that does not time out would wait out the 4 s sleep
    expect((await slow).status).toBe(201); // the stuck one finishes too, after its 4 s
  } finally { await uninstall(); }
  await expectBalanceMatchesLedger(owner, stuck.walletId);
  await expectBalanceMatchesLedger(owner, other.walletId);
});
