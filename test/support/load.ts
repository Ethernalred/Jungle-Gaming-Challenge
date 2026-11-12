import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { bodyOf, openWallet, submit } from './app';
import { Instance, queueDepth } from './cluster';
import { expectBalanceMatchesLedger } from './ledger';
import { dataOf, send as sendToQueue, requested, until } from './queue';

type W = { walletId: string; playerId: string };
const HOT_BETS = 60, HOT_REFUNDED = 15, Q_BETS = 40, Q_ROLLED_BACK = 10, SMALL = 6, SMALL_BETS = 6;

/** Runs `tasks` with at most `n` in flight. */
const pool = async (tasks: (() => Promise<unknown>)[], n = 16) => {
  const q = [...tasks];
  await Promise.all(Array.from({ length: n }, async () => { for (let t; (t = q.shift()); ) await t(); }));
};

/**
 * One workload for the three proofs: a hot Wallet (HTTP and queue, duplicates, Reversals that arrive before their BET) plus many small Wallets
 * that cannot afford all their BETs. Totals are deterministic whichever instance serves what. `live()` lists the instances to talk to.
 */
export async function makeLoad(live: () => Instance[], owner: MikroORM) {
  const first = live()[0];
  const hot = await openWallet(first.base, '1000.00');
  const small: W[] = await Promise.all(Array.from({ length: SMALL }, () => openWallet(first.base, '100.00')));
  const wallets = [hot, ...small];
  const hx = (i: number) => `${hot.walletId}:h${i}`, qx = (i: number) => `${hot.walletId}:q${i}`;
  let rr = 0;

  /** HTTP to the next live instance; a dead one (connection refused) or a 5xx is retried with the same Idempotency Key, like a Provider would. */
  const post = async (body: Record<string, unknown>) => {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const l = live();
      const inst = l[rr++ % l.length];
      if (inst) { const r = await submit(inst.base, body).catch(() => null); if (r && r.status < 500) return r.status; }
      await Bun.sleep(100);
    }
    throw new Error('no instance answered');
  };
  const dup = (n: number, f: () => Promise<unknown>) => Promise.all(Array.from({ length: n }, f));
  const bet = (w: W, ext: string, amount: string) => bodyOf({ ...w, kind: 'BET', amount, externalTransactionId: ext });
  const reversal = (kind: string, ext: string, ref: string, amount: string) => ({ ...bodyOf({ ...hot, kind, amount, externalTransactionId: ext }), referenceExternalTransactionId: ref });

  const self = {
    wallets, hot,
    expectedHot: (1000 - 2 * HOT_BETS + 2 * HOT_REFUNDED - Q_BETS + Q_ROLLED_BACK).toFixed(2),
    /** Reversals whose BET has not arrived: HTTP REFUNDs (PENDING_REFERENCE, 202) and queue ROLLBACKs. */
    early: async () => {
      // Finish HTTP setup before queue delivery can trigger the sole consumer's crash hook.
      // Recovery instances are started by the caller after early() returns.
      await pool([
        ...Array.from({ length: HOT_REFUNDED }, (_, i) => () => dup(2, () => post(reversal('REFUND', `${hx(i)}:r`, hx(i), '2.00')))),
      ]);
      await pool([
        ...Array.from({ length: Q_ROLLED_BACK }, (_, i) => async () => {
          const d = dataOf(hot, { externalTransactionId: `${qx(i)}:rb`, idempotencyKey: `prov-q:${qx(i)}:rb`, kind: 'ROLLBACK', money: { amount: '1.00', currency: 'BRL' }, referenceExternalTransactionId: qx(i) });
          await sendToQueue(requested(d), hot.walletId);
        }),
      ]);
    },
    /** The BETs: HTTP x3 duplicates on different instances, queue x2 (new messageId, same Idempotency Key), and small Wallets that overspend. */
    main: async () => {
      await pool([
        ...Array.from({ length: HOT_BETS }, (_, i) => () => dup(3, () => post(bet(hot, hx(i), '2.00')))),
        ...Array.from({ length: Q_BETS }, (_, i) => async () => {
          const d = dataOf(hot, { externalTransactionId: qx(i), idempotencyKey: `prov-q:${qx(i)}`, money: { amount: '1.00', currency: 'BRL' } });
          await sendToQueue(requested(d), hot.walletId); await sendToQueue(requested(d), hot.walletId);
        }),
        ...small.flatMap((w) => Array.from({ length: SMALL_BETS }, (_, i) => () => dup(2, () => post(bet(w, `${w.walletId}:b${i}`, '40.00'))))),
      ]);
    },
    counts: async () => ({
      pending: Number((await owner.em.execute(`select count(*) n from wager_transactions where status = 'PENDING_REFERENCE' and wallet_id in (?)`, [wallets.map((w) => w.walletId)]))[0].n),
      unpublished: Number((await owner.em.execute('select count(*) n from outbox_events where published_at is null and aggregate_id in (?)', [wallets.map((w) => w.walletId)]))[0].n),
    }),
    /** Waits until the pending references, the outbox and the queue are drained, then checks every invariant. */
    settle: async () => {
      const drained = async () => { const c = await self.counts(); return c.pending === 0 && c.unpublished === 0 && (await queueDepth()) === 0; };
      const ok = await until(drained, 90_000);
      expect(ok).toBe(true);
      const q = (sql: string, p: unknown[]) => owner.em.execute(sql, p);
      for (const w of wallets) {
        await expectBalanceMatchesLedger(owner, w.walletId);
        expect(Number((await q('select count(*) n from wallets where id = ? and balance < 0', [w.walletId]))[0].n)).toBe(0);
        // no double effect: one Ledger Entry per PROCESSED Wager Transaction, none for anything else
        const processed = Number((await q(`select count(*) n from wager_transactions where wallet_id = ? and status = 'PROCESSED'`, [w.walletId]))[0].n);
        const entries = Number((await q('select count(*) n from wallet_ledger_entries where wallet_id = ? and transaction_id is not null', [w.walletId]))[0].n);
        expect(entries).toBe(processed);
      }
      const bal = async (id: string) => (await q('select balance::text b from wallets where id = ?', [id]))[0].b;
      expect(await bal(hot.walletId)).toBe(self.expectedHot);
      const rows = Number((await q(`select count(*) n from wager_transactions where wallet_id = ? and kind <> 'OPENING'`, [hot.walletId]))[0].n);
      expect(rows).toBe(HOT_BETS + HOT_REFUNDED + Q_BETS + Q_ROLLED_BACK); // each submitted exactly once, however often delivered
      for (const w of small) {
        expect(await bal(w.walletId)).toBe('20.00'); // 100.00 - 2 x 40.00; the other four BETs are REJECTED INSUFFICIENT_FUNDS
        const st = await q(`select status, count(*) n from wager_transactions where wallet_id = ? and kind = 'BET' group by status`, [w.walletId]);
        expect(Object.fromEntries(st.map((r: any) => [r.status, Number(r.n)]))).toEqual({ PROCESSED: 2, REJECTED: SMALL_BETS - 2 });
      }
    },
  };
  return self;
}
