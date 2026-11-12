import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { holdWalletLock } from '../support/barrier';
import { pinned } from '../support/pin';
import { initOrm } from '../support/db';
import { expectBalanceMatchesLedger } from '../support/ledger';

/**
 * Checks a known limitation in ledger ordering under contention.
 * A Ledger Entry's created_at is the clock read when the request *arrived* (before the Wallet lock and before a pool
 * connection), not when it was *applied*. GET /wallets/:id/ledger orders by (created_at, id). So under contention the
 * listing can disagree with the order the entries were applied: balance_before of one entry is not balance_after of
 * the previous. No money is wrong (Balance == sum still holds); the audit trail reads out of order.
 * These tests are pinned (test/support/pin.ts): green while the limitation exists, red once it is fixed or if their setup breaks.
 */
setDefaultTimeout(60_000);
let app1: Awaited<ReturnType<typeof startApp>>;
let app2: Awaited<ReturnType<typeof startApp>>;
let owner: MikroORM;
beforeAll(async () => { app1 = await startApp(); app2 = await startApp(); owner = await initOrm(); }); // two instances, two pools
afterAll(async () => { await app1.app.close(); await app2.app.close(); await owner.close(); });

pinned('F6: a Ledger Entry is stamped when it is applied, not when its request arrived', async () => {
  const w = await openWallet(app1.base, '100.00');
  const lock = await holdWalletLock(owner, w.walletId);
  const bet = submit(app1.base, bodyOf({ ...w, amount: '10.00' }));
  expect(await lock.queued(1)).toBe(true);
  await Bun.sleep(300); // a deliberate gap between arrival and application: the length of the lock wait
  const releasedAt = Date.now(); // the app runs in this process: same clock as the one that stamps created_at
  await lock.release();
  expect((await bet).status).toBe(201);
  const [{ created_at }] = await owner.em.execute(
    `select e.created_at from wallet_ledger_entries e join wager_transactions t on t.id = e.transaction_id where e.wallet_id = ? and t.kind = 'BET'`, [w.walletId]);
  return { createdAt: new Date(created_at).getTime(), releasedAt };
}, ({ createdAt, releasedAt }) => expect(createdAt).toBeGreaterThanOrEqual(releasedAt));

/**
 * The consequence, built deterministically. X arrives first at instance 1 but waits for a pool connection (instance 1's
 * pool is filled by requests parked on another Wallet's lock). Y arrives later at instance 2 and is applied at once.
 * X is applied second but carries the earlier created_at, so the ledger listing puts it first.
 * The setup asserts that this really happened (X stamped first, applied second) before the listing is judged.
 */
pinned('F6: GET /wallets/:id/ledger lists entries in the order they were applied (balance_before chains to the previous balance_after)', async () => {
  const w = await openWallet(app1.base, '100.00');
  const blocker = await openWallet(app1.base, '1000.00');
  const lock = await holdWalletLock(owner, blocker.walletId);
  const parked = Array.from({ length: 10 }, () => submit(app1.base, bodyOf({ ...blocker, amount: '1.00' })));
  expect(await lock.queued(10)).toBe(true); // instance 1's 10 connections are all waiting on the blocker's lock
  const xBody = bodyOf({ ...w, amount: '10.00' });
  const x = submit(app1.base, xBody); // reads the clock now, then waits for a connection
  await Bun.sleep(100); // let X be read off the socket and stamped
  const yBody = bodyOf({ ...w, amount: '20.00' });
  expect((await submit(app2.base, yBody)).status).toBe(201); // Y: applied first, stamped later
  await lock.release();
  expect((await x).status).toBe(201);
  await Promise.all(parked);
  await expectBalanceMatchesLedger(owner, w.walletId); // the money is right either way
  const entry = async (ext: string) => (await owner.em.execute(`select e.created_at, e.balance_before::text before, e.balance_after::text after
    from wallet_ledger_entries e join wager_transactions t on t.id = e.transaction_id where t.external_transaction_id = ?`, [ext]))[0];
  const [ex, ey] = [await entry(xBody.externalTransactionId), await entry(yBody.externalTransactionId)];
  expect(new Date(ex.created_at).getTime()).toBeLessThan(new Date(ey.created_at).getTime()); // X stamped first...
  expect(ex.before).toBe(ey.after); // ...but applied after Y: the precondition of the finding holds
  return (await (await fetch(`${app1.base}/wallets/${w.walletId}/ledger`)).json()).items;
}, (items: any[]) => {
  const breaks = items.slice(1).filter((e: any, i: number) => e.balanceBefore.amount !== items[i].balanceAfter.amount);
  expect(breaks).toEqual([]);
});
