import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { appOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { initOrm } from '../support/db';
import { startApp, openWallet, bodyOf, submit } from '../support/app';
setDefaultTimeout(60_000);

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.app.close(); });

test('app role (D17): Ledger Entries cannot be updated or deleted, normal flows still work', async () => {
  const { walletId, playerId } = await openWallet(app.base, '100.00');
  expect((await submit(app.base, bodyOf({ walletId, playerId, kind: 'BET', amount: '10.00' }))).status).toBeLessThan(300);

  const orm = await MikroORM.init({ ...appOrmConfig, debug: false });
  const owner = await initOrm();
  try {
    const [{ u }] = await orm.em.execute('select current_user as u');
    expect(u).toBe('jungle_app');
    await expect(orm.em.execute('update wallet_ledger_entries set amount = amount')).rejects.toThrow(/permission denied/);
    await expect(orm.em.execute('delete from wallet_ledger_entries')).rejects.toThrow(/permission denied/);
    const [{ n }] = await owner.em.execute('select count(*)::int as n from wallet_ledger_entries where wallet_id = ?', [walletId]);
    expect(n).toBe(2); // opening credit + BET
  } finally {
    await orm.close();
    await owner.close();
  }
});
