import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { initOrm } from '../support/db';
import { expectWalletInvariants } from '../support/invariants';
setDefaultTimeout(60_000);

/**
 * Negative controls for expectWalletInvariants: a checker that never fails proves nothing. Each case corrupts ONE thing as
 * the DB owner, requires the checker to reject it, restores it, and requires the checker to pass again (positive control).
 * Ledger Entries are immutable by trigger, so only the Wallet and Wager Transaction rows are corrupted.
 */
let app: INestApplication, base: string, owner: MikroORM;
beforeAll(async () => { ({ app, base } = await startApp()); owner = await initOrm(); });
afterAll(async () => { await app.close(); await owner.close(); });

const sql = (q: string, p: unknown[] = []) => owner.em.getConnection().execute(q, p);

async function seeded() {
  const w = await openWallet(base, '100.00');
  const ids: Record<string, string> = {};
  for (const [name, kind, amount] of [['bet', 'BET', '30.00'], ['win', 'WIN', '10.00'], ['broke', 'BET', '500.00']] as const) {
    const r = await submit(base, bodyOf({ ...w, kind, amount }));
    ids[name] = (await r.json()).transactionId;
  }
  await expectWalletInvariants(owner, w.walletId); // sound before any corruption
  return { w, ids };
}

/** Run `corrupt`, expect the checker to reject with `violation` (the rule that must fire, not just any error), run `restore`, expect the checker to accept. */
async function control(walletId: string, violation: string, corrupt: () => Promise<unknown>, restore: () => Promise<unknown>) {
  await corrupt();
  try { await expect(expectWalletInvariants(owner, walletId)).rejects.toThrow(violation); } finally { await restore(); }
  await expectWalletInvariants(owner, walletId);
}

test('wallets.version off by one is rejected', async () => {
  const { w } = await seeded();
  await control(w.walletId, 'version 4 != 1 + 2 balance changes', () => sql('update wallets set version = version + 1 where id = ?', [w.walletId]), () => sql('update wallets set version = version - 1 where id = ?', [w.walletId]));
});

test('wallets.balance that no longer equals the ledger sum is rejected', async () => {
  const { w } = await seeded();
  await control(w.walletId, 'ledger sum', () => sql('update wallets set balance = balance + 1 where id = ?', [w.walletId]), () => sql('update wallets set balance = balance - 1 where id = ?', [w.walletId]));
});

test('a balance_snapshot the Wallet never had is rejected', async () => {
  const { w, ids } = await seeded();
  const [{ s }] = await sql('select balance_snapshot::text s from wager_transactions where id = ?', [ids.win]);
  await control(w.walletId, 'a Balance the Wallet never had', () => sql("update wager_transactions set balance_snapshot = '12.34' where id = ?", [ids.win]), () => sql('update wager_transactions set balance_snapshot = ? where id = ?', [s, ids.win]));
});

test('a PROCESSED BET turned REJECTED while its Ledger Entry stays is rejected', async () => {
  const { w, ids } = await seeded();
  await control(w.walletId, 'has 1 entries, expected 0',
    () => sql("update wager_transactions set status = 'REJECTED', failure_code = 'INTERNAL_ERROR' where id = ?", [ids.bet]),
    () => sql("update wager_transactions set status = 'PROCESSED', failure_code = null where id = ?", [ids.bet]));
});

test('INSUFFICIENT_FUNDS for an amount the snapshot already covered is rejected', async () => {
  const { w, ids } = await seeded();
  // snapshot 80.00 is a Balance the Wallet had, so only the "justified by the snapshot" rule can fire
  await control(w.walletId, 'but it saw', () => sql("update wager_transactions set amount = '70.00' where id = ?", [ids.broke]), () => sql("update wager_transactions set amount = '500.00' where id = ?", [ids.broke]));
});
