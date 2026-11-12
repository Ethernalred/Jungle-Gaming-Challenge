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

type W = { walletId: string; playerId: string };
const balanceOf = async (id: string) => (await (await fetch(`${base}/wallets/${id}`)).json()).balance.amount;
const tag = (w: W, ext: string) => `${w.walletId}:${ext}`; // external ids are unique per Provider, so scope them to the Wallet
const send = async (w: W, kind: string, ext: string, amount: string, ref?: string, extra: Record<string, unknown> = {}) => {
  const r = await submit(base, { ...bodyOf({ ...w, kind, amount, externalTransactionId: tag(w, ext) }), ...(ref ? { referenceExternalTransactionId: tag(w, ref) } : {}), ...extra });
  return { status: r.status, json: await r.json() };
};
const entryCount = async (id: string) => Number((await orm.em.getConnection().execute("select count(*) n from wallet_ledger_entries where wallet_id = ? and transaction_id is not null", [id]))[0].n);
const stored = async (w: W, ext: string) => (await orm.em.getConnection().execute('select * from wager_transactions where wallet_id = ? and external_transaction_id = ?', [w.walletId, tag(w, ext)]))[0];
const rejected = (r: { status: number; json: any }, code: string) => expect([r.status, r.json.code, r.json.status]).toEqual([422, code, 'REJECTED']);

test('REFUND credits the BET stake; ROLLBACK of a BET credits, of a WIN debits, of a REFUND debits; each is a Ledger Entry', async () => {
  const w = await openWallet(base, '100.00');
  expect((await send(w, 'BET', 'b1', '30.00')).json.balance.amount).toBe('70.00');
  const refund = await send(w, 'REFUND', 'r1', '30.00', 'b1');
  expect([refund.status, refund.json.balance.amount]).toEqual([201, '100.00']);
  expect((await stored(w, 'r1')).reference_transaction_id).toBe((await stored(w, 'b1')).id);
  expect((await send(w, 'ROLLBACK', 'rb-refund', '30.00', 'r1')).json.balance.amount).toBe('70.00'); // REFUND undone: debit
  await send(w, 'BET', 'b2', '10.00'); // 60
  await send(w, 'WIN', 'w2', '25.00', 'b2'); // 85, WIN with Reference to its BET
  expect((await send(w, 'ROLLBACK', 'rb-win', '25.00', 'w2')).json.balance.amount).toBe('60.00'); // debit
  expect((await send(w, 'ROLLBACK', 'rb-bet', '10.00', 'b2')).json.balance.amount).toBe('70.00'); // credit
  expect(await balanceOf(w.walletId)).toBe('70.00');
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('BET -> REFUND -> ROLLBACK of the BET is REJECTED ALREADY_REVERSED, stored, no Ledger Entry; the REFUND can be rolled back, the BET still not refunded again', async () => {
  const w = await openWallet(base, '100.00');
  await send(w, 'BET', 'b', '20.00');
  await send(w, 'REFUND', 'r', '20.00', 'b');
  const before = await entryCount(w.walletId);
  rejected(await send(w, 'ROLLBACK', 'rb', '20.00', 'b'), 'ALREADY_REVERSED');
  expect((await stored(w, 'rb'))).toMatchObject({ status: 'REJECTED', failure_code: 'ALREADY_REVERSED' });
  expect(await entryCount(w.walletId)).toBe(before);
  await send(w, 'ROLLBACK', 'rb-r', '20.00', 'r');
  rejected(await send(w, 'REFUND', 'r2', '20.00', 'b'), 'ALREADY_REVERSED'); // D8: ROLLBACK of REFUND does not free the BET
  expect(await balanceOf(w.walletId)).toBe('80.00');
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('Reference checks: MISMATCH, INVALID_REFERENCE_KIND, AMOUNT_MISMATCH, REFERENCE_NOT_PROCESSED, all REJECTED with no Ledger Entry', async () => {
  const w = await openWallet(base, '100.00');
  const other = await openWallet(base, '100.00');
  await send(w, 'BET', 'b', '20.00');
  await send(w, 'WIN', 'win', '5.00');
  await send(w, 'BET', 'big', '500.00'); // INSUFFICIENT_FUNDS -> REJECTED
  const n = await entryCount(w.walletId);
  rejected(await send(w, 'REFUND', 'm1', '20.00', 'b', { providerId: 'prov-a', roundId: 'round-2' }), 'REFERENCE_MISMATCH');
  rejected(await send(other, 'REFUND', 'm2', '20.00', undefined, { referenceExternalTransactionId: tag(w, 'b') }), 'REFERENCE_MISMATCH'); // other player and wallet
  rejected(await send(w, 'REFUND', 'k1', '5.00', 'win'), 'INVALID_REFERENCE_KIND');
  rejected(await send(w, 'WIN', 'k2', '20.00', 'win'), 'INVALID_REFERENCE_KIND');
  rejected(await send(w, 'REFUND', 'a1', '19.99', 'b'), 'AMOUNT_MISMATCH');
  rejected(await send(w, 'REFUND', 'np', '500.00', 'big'), 'REFERENCE_NOT_PROCESSED');
  expect(await entryCount(w.walletId)).toBe(n);
  expect(await balanceOf(w.walletId)).toBe('85.00');
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('ROLLBACK of a WIN that would overdraw: REVERSAL_WOULD_OVERDRAW (not INSUFFICIENT_FUNDS), stored; ROLLBACK within funds works', async () => {
  const w = await openWallet(base, '10.00');
  await send(w, 'WIN', 'w', '50.00'); // 60
  await send(w, 'BET', 'b', '55.00'); // 5
  const r = await send(w, 'ROLLBACK', 'rb', '50.00', 'w');
  rejected(r, 'REVERSAL_WOULD_OVERDRAW');
  expect(r.json.balance.amount).toBe('5.00');
  expect(await stored(w, 'rb')).toMatchObject({ status: 'REJECTED', failure_code: 'REVERSAL_WOULD_OVERDRAW' });
  expect(await balanceOf(w.walletId)).toBe('5.00');
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('missing Reference: 202 PENDING_REFERENCE stored with no Ledger Entry; Replay is 202 idempotentReplay true; a Reference of a PENDING_REFERENCE row also stays pending', async () => {
  const w = await openWallet(base, '100.00');
  const first = await send(w, 'REFUND', 'r', '10.00', 'later');
  expect(first.status).toBe(202);
  expect(first.json).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: false });
  const replay = await send(w, 'REFUND', 'r', '10.00', 'later');
  expect([replay.status, replay.json]).toEqual([202, { ...first.json, idempotentReplay: true }]);
  const chained = await send(w, 'ROLLBACK', 'rb', '10.00', 'r'); // its Reference is itself PENDING_REFERENCE
  expect([chained.status, chained.json.status]).toEqual([202, 'PENDING_REFERENCE']);
  expect(await stored(w, 'r')).toMatchObject({ status: 'PENDING_REFERENCE', reference_transaction_id: null });
  expect(await entryCount(w.walletId)).toBe(1); // only the OPENING entry
  await expectBalanceMatchesLedger(orm, w.walletId);
});

test('currency mismatch with the Wallet is still CURRENCY_MISMATCH on a REFUND', async () => {
  const w = await openWallet(base, '100.00');
  await send(w, 'BET', 'b', '10.00');
  rejected(await send(w, 'REFUND', 'r', '10.00', 'b', { money: { amount: '10.00', currency: 'USD' } }), 'CURRENCY_MISMATCH');
});
