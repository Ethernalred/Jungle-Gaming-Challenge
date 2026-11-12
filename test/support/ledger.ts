import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { expectWalletInvariants } from './invariants';

/** Final invariant: Wallet Balance == Balance rebuilt from its Ledger Entries (Reconciliation). */
export async function expectBalanceMatchesLedger(orm: MikroORM, walletId: string) {
  const c = orm.em.getConnection();
  const [w] = await c.execute('select balance::text as b from wallets where id = ?', [walletId]);
  const [l] = await c.execute(
    `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text as s from wallet_ledger_entries where wallet_id = ?`,
    [walletId]);
  expect(w.b).toBe(l.s); // exact NUMERIC(19,2) decimal strings, never Number()
  await expectWalletInvariants(orm, walletId); // the stronger, order-free checks (test/support/invariants.ts)
}
