import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

/** NUMERIC(19,2) text -> cents. Never Number(): exact or nothing. */
const cents = (s: string) => BigInt(s.replace('.', ''));

/**
 * True when the entries, read as edges balance_before -> balance_after, form ONE walk that starts at 0, uses every entry
 * exactly once and ends at `final` (an Euler path). It needs no order, so it works however entries are stored or listed:
 * degrees must balance (every node entered as often as left, except start and end) and all edges must be connected to 0.
 * Catches entries that do not chain (a lost update writes two edges out of the same balance), invented intermediate
 * states, and a final balance the ledger cannot reach. It cannot tell two different walks over the same edges apart.
 */
export function ledgerIsAWalk(entries: { before: bigint; after: bigint }[], final: bigint): boolean {
  const deg = new Map<bigint, number>([[0n, 0], [final, 0]]);
  const parent = new Map<bigint, bigint>();
  const find = (x: bigint): bigint => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
  for (const { before, after } of entries) {
    deg.set(before, (deg.get(before) ?? 0) + 1);
    deg.set(after, (deg.get(after) ?? 0) - 1);
    for (const n of [before, after]) if (!parent.has(n)) parent.set(n, n);
    parent.set(find(before), find(after));
  }
  if (!entries.length) return final === 0n;
  for (const [node, d] of deg) if (d !== (node === 0n ? 1 : 0) - (node === final ? 1 : 0)) return false;
  const root = parent.has(0n) ? find(0n) : null;
  return root !== null && [...parent.keys()].every((n) => find(n) === root);
}

const DIRECTION: Record<string, string> = { OPENING: 'CREDIT', BET: 'DEBIT', WIN: 'CREDIT', REFUND: 'CREDIT' };

/**
 * Every invariant that can be read from the database for one Wallet, beyond "Balance == sum of entries":
 * non-negative; the ledger is a walk 0 -> Balance; version = 1 + balance changes; each PROCESSED balance-moving
 * Wager Transaction has exactly one entry and nothing else has any (§6.2 "e vice-versa"); entry amount and direction
 * match the Kind; at most one processed Reversal per Reference; every stored balance_snapshot is a Balance the Wallet
 * really had, and rejections for funds were justified by it.
 * Collects violations as text so a failure says which rule broke.
 */
export async function expectWalletInvariants(orm: MikroORM, walletId: string) {
  // One REPEATABLE READ snapshot for all three reads: with three separate queries a movement committing in between
  // would show up as a false violation (or hide a real one) on a Wallet that is still being written.
  const { w, entries, txs } = await orm.em.fork().transactional(async (em) => {
    await em.execute('set transaction isolation level repeatable read'); // must be the first statement
    const q = (sql: string) => em.execute(sql, [walletId]);
    return {
      w: (await q('select balance::text b, version from wallets where id = ?'))[0],
      entries: await q(`
    select e.transaction_id, e.direction, e.amount::text amount, e.balance_before::text before, e.balance_after::text after,
           t.kind, t.status, t.amount::text t_amount, t.wallet_id, r.kind ref_kind
    from wallet_ledger_entries e join wager_transactions t on t.id = e.transaction_id
    left join wager_transactions r on r.id = t.reference_transaction_id
    where e.wallet_id = ?`),
      txs: await q(`select id, kind, status, failure_code, amount::text amount, balance_snapshot::text snapshot, reference_transaction_id
    from wager_transactions where wallet_id = ?`),
    };
  });

  const bad: string[] = [];
  const balance = cents(w.b);
  if (balance < 0n) bad.push(`negative Balance ${w.b}`);
  const sum = entries.reduce((s: bigint, e: any) => s + (e.direction === 'CREDIT' ? 1n : -1n) * cents(e.amount), 0n);
  if (sum !== balance) bad.push(`Balance ${w.b} != ledger sum ${sum}`);
  const edges = entries.map((e: any) => ({ before: cents(e.before), after: cents(e.after) }));
  if (!ledgerIsAWalk(edges, balance)) bad.push('Ledger Entries do not form one walk from 0 to the Balance');
  const changes = entries.filter((e: any) => e.kind !== 'OPENING').length;
  if (Number(w.version) !== 1 + changes) bad.push(`version ${w.version} != 1 + ${changes} balance changes`);

  const byTx = new Map<string, any[]>();
  for (const e of entries) {
    byTx.set(e.transaction_id, [...(byTx.get(e.transaction_id) ?? []), e]);
    const want = e.kind === 'ROLLBACK' ? (DIRECTION[e.ref_kind] === 'DEBIT' ? 'CREDIT' : 'DEBIT') : DIRECTION[e.kind];
    if (e.direction !== want) bad.push(`${e.kind} ${e.transaction_id} wrote ${e.direction}, expected ${want}`);
    if (e.amount !== e.t_amount) bad.push(`entry amount ${e.amount} != Wager Transaction amount ${e.t_amount}`);
    if (e.wallet_id !== walletId) bad.push(`entry on this Wallet for a Wager Transaction of Wallet ${e.wallet_id}`);
  }

  const nodes = new Set<bigint>([0n, ...edges.flatMap((e: { before: bigint; after: bigint }) => [e.before, e.after])]);
  const reversals = new Map<string, number>();
  for (const t of txs) {
    const n = byTx.get(t.id)?.length ?? 0;
    const want = t.status === 'PROCESSED' && t.kind !== 'LOSS' ? 1 : 0;
    if (n !== want) bad.push(`${t.status} ${t.kind} ${t.id} has ${n} entries, expected ${want}`);
    if (t.status === 'PROCESSED' && (t.kind === 'REFUND' || t.kind === 'ROLLBACK')) {
      reversals.set(t.reference_transaction_id, (reversals.get(t.reference_transaction_id) ?? 0) + 1);
    }
    if (t.snapshot === null) continue;
    const snap = cents(t.snapshot);
    if (!nodes.has(snap)) bad.push(`${t.kind} ${t.id} snapshot ${t.snapshot} is a Balance the Wallet never had`);
    if (n === 1 && cents(byTx.get(t.id)![0].after) !== snap) bad.push(`${t.kind} ${t.id} snapshot ${t.snapshot} != its entry's balance_after`);
    if ((t.failure_code === 'INSUFFICIENT_FUNDS' || t.failure_code === 'REVERSAL_WOULD_OVERDRAW') && !(snap < cents(t.amount))) {
      bad.push(`${t.failure_code} ${t.id} for ${t.amount} but it saw ${t.snapshot}`);
    }
  }
  for (const [ref, n] of reversals) if (n > 1) bad.push(`${ref} reversed ${n} times`);
  expect(bad).toEqual([]);
}
