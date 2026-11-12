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

const balanceOf = async (id: string) => (await (await fetch(`${base}/wallets/${id}`)).json()).balance.amount;
const count = async (sql: string, p: unknown[]) => Number((await orm.em.getConnection().execute(sql, p))[0].n);

test('the same BET sent 50 times in parallel: one debit, 1 x 201 and 49 x 200 Replays', async () => {
  const w = await openWallet(base, '100.00');
  const body = bodyOf({ ...w, amount: '10.00' });
  const results = await Promise.all(Array.from({ length: 50 }, async () => {
    const r = await submit(base, body);
    return { status: r.status, json: await r.json() };
  }));
  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  expect(results.filter((r) => r.status === 200 && r.json.idempotentReplay === true)).toHaveLength(49);
  expect(new Set(results.map((r) => r.json.transactionId)).size).toBe(1);
  expect(new Set(results.map((r) => r.json.balance.amount))).toEqual(new Set(['90.00']));
  expect(await balanceOf(w.walletId)).toBe('90.00');
  expect(await count("select count(*) n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.walletId])).toBe(1);
  expect(await count("select count(*) n from wager_transactions where wallet_id = ? and kind = 'BET'", [w.walletId])).toBe(1);
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('Balance 100.00 and two parallel 80.00 BETs: one PROCESSED, one REJECTED INSUFFICIENT_FUNDS, Balance 20.00, one DEBIT', async () => {
  const w = await openWallet(base, '100.00');
  const rs = await Promise.all([0, 1].map(async () => {
    const r = await submit(base, bodyOf({ ...w, amount: '80.00' }));
    return { status: r.status, json: await r.json() };
  }));
  expect(rs.map((r) => r.status).sort()).toEqual([201, 422]);
  expect(rs.find((r) => r.status === 422)!.json.code).toBe('INSUFFICIENT_FUNDS');
  expect(await balanceOf(w.walletId)).toBe('20.00');
  expect(await count("select count(*) n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.walletId])).toBe(1);
  expect(await count("select count(*) n from wager_transactions where wallet_id = ? and status = 'REJECTED' and failure_code = 'INSUFFICIENT_FUNDS'", [w.walletId])).toBe(1);
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('many Wallets in parallel, mixed BET/WIN/LOSS plus duplicates, all end consistent', async () => {
  const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(base, '100.00')));
  await Promise.all(wallets.flatMap((w) => {
    const subs = (['BET', 'BET', 'WIN', 'LOSS', 'BET'] as const).map((kind, i) => bodyOf({ ...w, kind, amount: `${10 + i}.00` }));
    return [...subs, ...subs].map((b) => submit(base, b).then((r) => expect([200, 201]).toContain(r.status)));
  }));
  for (const w of wallets) {
    expect(await balanceOf(w.walletId)).toBe('100.00'.replace('100.00', String(100 - 10 - 11 + 12 - 14) + '.00')); // 77.00
    expect(await count("select count(*) n from wager_transactions where wallet_id = ? and kind <> 'OPENING'", [w.walletId])).toBe(5);
    await expectBalanceMatchesLedger(orm, w.walletId);
  }
});
