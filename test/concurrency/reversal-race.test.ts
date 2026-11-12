import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { expectBalanceMatchesLedger } from '../support/ledger';
setDefaultTimeout(60_000);

let app: INestApplication;
let base: string;
let orm: MikroORM;
beforeAll(async () => { ({ app, base } = await startApp()); orm = app.get(MikroORM); });
afterAll(() => app.close());

const count = async (sql: string, p: unknown[]) => Number((await orm.em.getConnection().execute(sql, p))[0].n);

test('the same BET REFUNDed and ROLLED BACK in parallel: exactly one Processed Reversal, the other ALREADY_REVERSED, Balance == ledger', async () => {
  for (let round = 0; round < 5; round++) { // repeated rounds inside the test as well
    const w = await openWallet(base, '100.00');
    const bet = bodyOf({ ...w, amount: '40.00', externalTransactionId: `bet-${w.walletId}` });
    expect((await submit(base, bet)).status).toBe(201);
    const rs = await Promise.all(['REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK'].map(async (kind, i) => {
      const r = await submit(base, { ...bodyOf({ ...w, kind, amount: '40.00', externalTransactionId: `rev-${i}-${w.walletId}` }), referenceExternalTransactionId: bet.externalTransactionId });
      return { status: r.status, json: await r.json() };
    }));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 422 && r.json.code === 'ALREADY_REVERSED')).toHaveLength(3);
    expect(await count("select count(*) n from wager_transactions where wallet_id = ? and status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')", [w.walletId])).toBe(1);
    expect(await count("select count(*) n from wallet_ledger_entries where wallet_id = ? and direction = 'CREDIT' and transaction_id in (select id from wager_transactions where kind <> 'OPENING')", [w.walletId])).toBe(1);
    expect((await (await fetch(`${base}/wallets/${w.walletId}`)).json()).balance.amount).toBe('100.00');
    await expectBalanceMatchesLedger(orm, w.walletId);
  }
});
