import { WalletLedgerEntry } from '../domain/ledger-entry';
import { ledgerDirectionFor, referenceViolation } from '../domain/reference-rules';
import { WagerTransaction } from '../domain/wager-transaction';
import { LockedWallet } from './wager-ports';

/**
 * Resolves the Reference of a PENDING or PENDING_REFERENCE Wager Transaction (D9) and applies it to the locked Wallet.
 * Must run inside the DB transaction holding the Wallet lock, so the Reference lookup and the Reversal check
 * cannot race. Sets the Wager Transaction's Status (also PENDING_REFERENCE) and returns the Ledger Entry to save, if any.
 * The pending-reference worker calls this again for a stored PENDING_REFERENCE row.
 */
export async function resolveReference(
  tx: WagerTransaction, locked: LockedWallet, ids: { next(): string }, at: Date,
): Promise<WalletLedgerEntry | null> {
  const wallet = locked.wallet!;
  const reject = (code: Parameters<WagerTransaction['reject']>[0]) => { tx.reject(code, wallet.balance, at); return null; };
  const ref = await locked.findReference(tx.state.providerId, tx.state.referenceExternalTransactionId!);

  if (!ref || ref.status === 'PENDING_REFERENCE' || ref.status === 'PENDING') {
    if (tx.status === 'PENDING') tx.markPendingReference(wallet.balance, at); // already pending: stays
    return null;
  }
  tx.linkReference(ref.id);
  if (ref.status !== 'PROCESSED') return reject('REFERENCE_NOT_PROCESSED'); // REJECTED / FAILED
  const violation = referenceViolation(tx, ref);
  if (violation) return reject(violation);
  const reversal = tx.kind === 'REFUND' || tx.kind === 'ROLLBACK';
  if (reversal && (await locked.hasProcessedReversal(ref.id))) return reject('ALREADY_REVERSED');

  const direction = ledgerDirectionFor(tx.kind, ref.kind);
  if (direction === 'DEBIT' && wallet.balance.isLessThan(tx.money)) return reject('REVERSAL_WOULD_OVERDRAW'); // only a ROLLBACK debits here
  const movement = { entryId: ids.next(), transactionId: tx.id, money: tx.money, at };
  const entry = direction === 'DEBIT' ? wallet.debit(movement) : wallet.credit(movement);
  tx.markProcessed(wallet.balance, at);
  return entry;
}
