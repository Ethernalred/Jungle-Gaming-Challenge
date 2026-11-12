import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import fc from 'fast-check';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuid } from 'uuid';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { holdWalletLock } from '../support/barrier';
import { initOrm } from '../support/db';
import { expectBalanceMatchesLedger } from '../support/ledger';

/**
 * Model-based testing. fast-check generates sequences of Provider requests: new BET/WIN/LOSS/REFUND/ROLLBACK (with or
 * without a Reference to an earlier request or to one that never arrives), exact resends, same key with another amount,
 * same external id under another key. Each request goes over HTTP; a small reference model written from Requirements §7
 * and ARCHITECTURE.md predicts its status, Failure Code and Balance. On a mismatch fast-check shrinks the sequence to a
 * minimal one and prints a seed: rerun with FC_SEED=<seed> FC_PATH=<path>. More runs: FC_RUNS=500.
 * Category: specification compliance (sequential) and reliability hardening (concurrent).
 * The model encodes this repo's documented interpretations (ARCHITECTURE "Interpretations"); see 03-gap-analysis for the
 * places where the spec allows others.
 */
setDefaultTimeout(300_000);
let app: Awaited<ReturnType<typeof startApp>>;
let owner: MikroORM;
beforeAll(async () => {
  process.env.PENDING_REFERENCE_WORKER = 'off'; // pending rows stay pending, so the model need not predict worker timing
  process.env.OUTBOX_PUBLISHER = 'off';
  app = await startApp(); owner = await initOrm();
});
afterAll(async () => { await app.app.close(); await owner.close(); delete process.env.PENDING_REFERENCE_WORKER; delete process.env.OUTBOX_PUBLISHER; });

// Pinned seed by default: the CI run is reproducible and the coverage guard below is stable. Explore with FC_SEED=<n> FC_RUNS=<n>.
const runs = { numRuns: Number(process.env.FC_RUNS ?? 60), seed: Number(process.env.FC_SEED ?? 20261111), path: process.env.FC_PATH };
// 0.29 and 1.15 are not exact in binary floating point (0.29 * 100 = 28.999…): a float anywhere on the money path loses a cent.
const AMOUNTS = ['0.29', '1.15', '5.00', '25.00', '60.00'];
const cents = (s: string) => BigInt(s.replace('.', ''));
const fmt = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;

// ---- the reference model -------------------------------------------------------------------------------------------
type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
type Stored = { ext: string; key: string; body: Record<string, unknown>; kind: Kind; amount: bigint; round: string; status: string; code?: string; reversed: boolean; credit?: boolean; balance: bigint };
type Expect = { status: number; code?: string; balance?: string; replay?: boolean };
const ALLOWED: Partial<Record<Kind, Kind[]>> = { REFUND: ['BET'], ROLLBACK: ['BET', 'WIN', 'REFUND'], WIN: ['BET'] };

class Model {
  stored: Stored[] = [];
  constructor(public balance: bigint) {}

  submitNew(kind: Kind, amount: bigint, ref: Stored | 'ghost' | undefined, round: string, currency: string): Pick<Stored, 'status' | 'code' | 'credit'> {
    const reject = (code: string) => ({ status: 'REJECTED', code });
    // D9 order: Wallet currency first (the Wallet is BRL), even before a missing Reference. Balance stays the Wallet's.
    if (currency !== 'BRL') return reject('CURRENCY_MISMATCH');
    if (ref !== undefined) {
      if (ref === 'ghost' || ref.status === 'PENDING_REFERENCE') return { status: 'PENDING_REFERENCE' };
      if (ref.status !== 'PROCESSED') return reject('REFERENCE_NOT_PROCESSED');
      // match: provider/player/Wallet are constant in this test and a PROCESSED Reference already has the Wallet's currency
      // (a foreign one is rejected before it), so only the Round can differ. Checked before Kind and amount (reference-rules.ts).
      if (round !== ref.round) return reject('REFERENCE_MISMATCH');
      if (!ALLOWED[kind]?.includes(ref.kind)) return reject('INVALID_REFERENCE_KIND');
      const reversal = kind === 'REFUND' || kind === 'ROLLBACK';
      if (reversal && amount !== ref.amount) return reject('AMOUNT_MISMATCH'); // a WIN is a payout: its amount may differ from the BET (F5, Requirements §7 rule 5)
      if (reversal && ref.reversed) return reject('ALREADY_REVERSED');
      const credit = kind === 'ROLLBACK' ? !ref.credit : true;
      if (!credit && this.balance < amount) return reject('REVERSAL_WOULD_OVERDRAW');
      this.balance += credit ? amount : -amount;
      if (reversal) ref.reversed = true;
      return { status: 'PROCESSED', credit };
    }
    if (kind === 'BET') {
      if (this.balance < amount) return reject('INSUFFICIENT_FUNDS');
      this.balance -= amount;
      return { status: 'PROCESSED', credit: false };
    }
    if (kind === 'WIN') { this.balance += amount; return { status: 'PROCESSED', credit: true }; }
    return { status: 'PROCESSED' }; // LOSS
  }
}
const httpOf = (s: Pick<Stored, 'status' | 'code' | 'balance'>, replay: boolean): Expect => ({
  status: s.status === 'PROCESSED' ? (replay ? 200 : 201) : s.status === 'REJECTED' ? 422 : 202, code: s.code, balance: fmt(s.balance), replay,
});

// ---- the generated commands ----------------------------------------------------------------------------------------
const kind = fc.constantFrom<Kind>('BET', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK');
const command = fc.oneof(
  // sameAmount: a Reference usually carries its original's amount; otherwise AMOUNT_MISMATCH (REFUND/ROLLBACK) would hide every later rule
  { weight: 6, arbitrary: fc.record({ t: fc.constant('new' as const), kind, amount: fc.constantFrom(...AMOUNTS), ref: fc.integer({ min: -1, max: 6 }), withRef: fc.integer({ min: 0, max: 9 }), cur: fc.integer({ min: 0, max: 11 }), rnd: fc.integer({ min: 0, max: 5 }), sameAmount: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('replay' as const), pick: fc.nat(6) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('keyConflict' as const), pick: fc.nat(6) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('externalIdConflict' as const), pick: fc.nat(6) }) },
);
type Command = typeof command extends fc.Arbitrary<infer C> ? C : never;

async function post(body: Record<string, unknown>, key: string) {
  const r = await submit(app.base, body, key);
  return { status: r.status, json: await r.json() };
}

test('model-based: any sequence of Provider requests on one Wallet gets the responses the model predicts, and the ledger stays consistent', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom('0.00', '50.00', '100.00'), fc.array(command, { minLength: 8, maxLength: 30 }), async (opening, commands: Command[]) => {
    const w = await openWallet(app.base, opening);
    const model = new Model(cents(opening));
    const recent = (n: number) => model.stored[model.stored.length - 1 - (n % model.stored.length)];
    for (const [step, c] of commands.entries()) {
      let got: { status: number; json: any }, want: Expect;
      if (c.t === 'new') {
        // REFUND/ROLLBACK always carry a Reference, WIN half the time, BET/LOSS rarely (an invalid Reference Kind)
        const carries = c.kind === 'REFUND' || c.kind === 'ROLLBACK' || (c.kind === 'WIN' ? c.withRef < 5 : c.withRef === 0);
        const pick = carries ? c.ref : undefined;
        // State-aware choice: usually a Reference of an allowed Kind (else REFUND rarely meets a BET and the later rules go
        // untested), sometimes any earlier request (INVALID_REFERENCE_KIND), sometimes one that never arrives (ghost).
        const allowed = model.stored.filter((s) => ALLOWED[c.kind]?.includes(s.kind));
        const pool = c.withRef === 1 || !allowed.length ? model.stored : allowed;
        const ref = pick === undefined ? undefined : pick === -1 || !pool.length ? 'ghost' as const : pool[pool.length - 1 - (pick % pool.length)];
        const ext = `${w.walletId}:${step}`;
        const amount = ref && ref !== 'ghost' && c.sameAmount ? fmt(ref.amount) : c.amount;
        const currency = c.cur === 0 ? 'USD' : 'BRL'; // 1 in 12: foreign currency
        const round = c.rnd === 0 ? 'round-2' : 'round-1'; // 1 in 6: another Round than most (so a Reference can differ)
        const body = { ...bodyOf({ ...w, kind: c.kind, amount, currency, externalTransactionId: ext }), roundId: round,
          ...(ref ? { referenceExternalTransactionId: ref === 'ghost' ? `ghost-${uuid()}` : ref.ext } : {}) };
        const outcome = model.submitNew(c.kind, cents(amount), ref, round, currency);
        const s: Stored = { ext, key: `k:${ext}`, body, kind: c.kind, amount: cents(amount), round, reversed: false, ...outcome, balance: model.balance };
        model.stored.push(s);
        got = await post(body, s.key);
        want = httpOf(s, false);
      } else {
        if (!model.stored.length) continue;
        const s = recent(c.pick);
        if (c.t === 'replay') { got = await post(s.body, s.key); want = httpOf(s, true); }
        else if (c.t === 'keyConflict') {
          got = await post({ ...s.body, money: { amount: s.amount === 500n ? '6.00' : '5.00', currency: 'BRL' } }, s.key);
          want = { status: 409, code: 'IDEMPOTENCY_CONFLICT' };
        } else { got = await post(s.body, `other:${s.key}`); want = { status: 409, code: 'EXTERNAL_ID_CONFLICT' }; }
      }
      const seen: Expect = { status: got.status, code: got.status === 409 || got.status === 422 ? got.json.code : undefined };
      if (want.balance !== undefined) Object.assign(seen, { balance: got.json.balance?.amount, replay: got.json.idempotentReplay });
      expect({ step, command: c, ...seen }).toEqual({ step, command: c, ...want });
      const outcome = want.replay ? (want.code ? 'rejection replay' : `${want.status} replay`) : want.code ?? `${want.status}`;
      covered.set(outcome, (covered.get(outcome) ?? 0) + 1);
    }
    expect((await (await fetch(`${app.base}/wallets/${w.walletId}`)).json()).balance.amount).toBe(fmt(model.balance));
    await expectBalanceMatchesLedger(owner, w.walletId);
  }), { ...runs, examples: RARE_PATHS });
  // Coverage guard: a property that never reaches a rule proves nothing about it (a first version of this test passed
  // with the ALREADY_REVERSED rule deleted from the model, because no generated sequence reversed a BET twice).
  console.log('model-based outcomes:', Object.fromEntries([...covered].sort()));
  expect(MUST_COVER.filter((o) => !covered.has(o))).toEqual([]);
});
const covered = new Map<string, number>();
/**
 * Seeded examples, always run before the random ones: paths random generation reaches only by luck. Without this, a change
 * of amounts made REVERSAL_WOULD_OVERDRAW vanish from 60 random runs and the coverage guard (rightly) failed.
 * ROLLBACK of a WIN after the money was spent: pool for ROLLBACK is [WIN, BET], ref 1 picks the WIN.
 */
const RARE_PATHS: [string, Command[]][] = [['0.00', [
  { t: 'new', kind: 'WIN', amount: '60.00', ref: 0, withRef: 9, cur: 9, rnd: 9, sameAmount: true },
  { t: 'new', kind: 'BET', amount: '60.00', ref: 0, withRef: 9, cur: 9, rnd: 9, sameAmount: true },
  { t: 'new', kind: 'ROLLBACK', amount: '60.00', ref: 1, withRef: 2, cur: 9, rnd: 9, sameAmount: true },
  { t: 'replay', pick: 0 },
]]];
const MUST_COVER = ['201', '200 replay', '202', '202 replay', 'rejection replay', 'INSUFFICIENT_FUNDS', 'ALREADY_REVERSED', 'AMOUNT_MISMATCH',
  'INVALID_REFERENCE_KIND', 'REVERSAL_WOULD_OVERDRAW', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_MISMATCH', 'CURRENCY_MISMATCH', 'IDEMPOTENCY_CONFLICT', 'EXTERNAL_ID_CONFLICT'];

/**
 * No model can predict which of several racing requests wins, but the outcome must still be explainable: whatever the
 * clients were told (201 with a Balance, 422 with the Balance it saw) has to add up to the ledger. The batch is forced
 * to contend (all requests proven queued on the Wallet lock), and includes exact duplicates.
 */
test('concurrent: a random batch forced to contend on one Wallet: what the clients were told adds up to the ledger', async () => {
  const op = fc.record({ kind: fc.constantFrom<Kind>('BET', 'BET', 'BET', 'WIN', 'LOSS'), amount: fc.constantFrom(...AMOUNTS), copies: fc.integer({ min: 1, max: 2 }) });
  await fc.assert(fc.asyncProperty(fc.constantFrom('20.00', '50.00', '100.00'), fc.array(op, { minLength: 2, maxLength: 6 }), async (opening, ops) => {
    const w = await openWallet(app.base, opening);
    const bodies = ops.map((o) => ({ o, body: bodyOf({ ...w, kind: o.kind, amount: o.amount }) }));
    const lock = await holdWalletLock(owner, w.walletId);
    const sends = bodies.flatMap(({ o, body }) => Array.from({ length: o.copies }, () => post(body, `${body.providerId}:${body.externalTransactionId}`)));
    expect(await lock.queued(Math.min(sends.length, 8))).toBe(true);
    await lock.release();
    const rs = await Promise.all(sends);

    let i = 0, expected = cents(opening);
    for (const { o } of bodies) {
      const mine = rs.slice(i, (i += o.copies));
      expect(new Set(mine.map((r) => r.json.transactionId)).size).toBe(1); // copies are one Wager Transaction
      expect(mine.filter((r) => r.json.idempotentReplay === false)).toHaveLength(1);
      const first = mine.find((r) => r.json.idempotentReplay === false)!;
      expect(mine.every((r) => r.json.balance.amount === first.json.balance.amount)).toBe(true); // Replays carry the original snapshot
      if (first.status === 201 && o.kind !== 'LOSS') expected += (o.kind === 'BET' ? -1n : 1n) * cents(o.amount);
      if (first.status === 422) { expect(first.json.code).toBe('INSUFFICIENT_FUNDS'); expect(cents(first.json.balance.amount) < cents(o.amount)).toBe(true); }
      expect([201, 422]).toContain(first.status);
    }
    expect((await (await fetch(`${app.base}/wallets/${w.walletId}`)).json()).balance.amount).toBe(fmt(expected));
    await expectBalanceMatchesLedger(owner, w.walletId);
  }), { ...runs, numRuns: Math.ceil(runs.numRuns / 2) });
});
