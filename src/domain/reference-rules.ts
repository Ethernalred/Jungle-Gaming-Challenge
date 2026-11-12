import { LedgerDirection } from './ledger-entry';
import { FailureCode, Kind, WagerTransaction } from './wager-transaction';

/** D7: which Kinds each Kind may reference. */
const ALLOWED: Partial<Record<Kind, Kind[]>> = { REFUND: ['BET'], ROLLBACK: ['BET', 'WIN', 'REFUND'], WIN: ['BET'] };
const DIRECTION: Partial<Record<Kind, LedgerDirection>> = { BET: 'DEBIT', WIN: 'CREDIT', REFUND: 'CREDIT' };

/** Direction of the Ledger Entry a Kind writes; a ROLLBACK is the opposite of its Reference's direction (D7). */
export function ledgerDirectionFor(kind: Kind, referenceKind?: Kind): LedgerDirection {
  if (kind !== 'ROLLBACK') return DIRECTION[kind]!;
  return DIRECTION[referenceKind!] === 'DEBIT' ? 'CREDIT' : 'DEBIT';
}

/** D7 checks against a PROCESSED Reference, in order: match, Kind, amount (REFUND/ROLLBACK only: a WIN is a payout). null = valid. */
export function referenceViolation(tx: WagerTransaction, ref: WagerTransaction): FailureCode | null {
  const a = tx.state, b = ref.state;
  if (a.providerId !== b.providerId || a.playerId !== b.playerId || a.walletId !== b.walletId || a.roundId !== b.roundId || !a.money.currency || a.money.currency !== b.money.currency) {
    return 'REFERENCE_MISMATCH';
  }
  if (!ALLOWED[a.kind]?.includes(b.kind)) return 'INVALID_REFERENCE_KIND';
  if ((a.kind === 'REFUND' || a.kind === 'ROLLBACK') && !a.money.equals(b.money)) return 'AMOUNT_MISMATCH';
  return null;
}
