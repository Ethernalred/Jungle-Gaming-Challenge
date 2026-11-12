import { WagerTransaction } from './wager-transaction';
import { WalletLedgerEntry } from './ledger-entry';
import {
  IntegrationEvent, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged,
} from './events/integration-event';

/** D24: 1 s x 2^n, capped at 5 min, no attempt limit (a confirmed event is never dropped). n = failed attempts so far. */
export const backoffMs = (attempts: number, baseMs = 1000, capMs = 300_000) => Math.min(capMs, baseMs * 2 ** Math.min(attempts, 30));

export interface Trace { correlationId: string; causationId?: string }

/** D23: the integration events of one stored Wager Transaction outcome (+ the Balance change, only when the Ledger Entry exists). */
export function eventsFor(tx: WagerTransaction, entry: WalletLedgerEntry | null, walletVersion: number, ids: { next(): string }, at: Date, trace: Trace): IntegrationEvent<any>[] {
  const s = tx.state;
  const data = {
    transactionId: s.id, walletId: s.walletId, playerId: s.playerId, providerId: s.providerId,
    externalTransactionId: s.externalTransactionId, kind: s.kind, money: s.money.toJSON(), balance: s.balanceSnapshot!.toJSON(),
  };
  const base = { eventId: ids.next(), occurredAt: at, ...trace };
  const out: IntegrationEvent<any>[] =
    s.status === 'PROCESSED' ? [new WagerTransactionProcessed({ ...base, data })]
    : s.status === 'REJECTED' ? [new WagerTransactionRejected({ ...base, data: { ...data, failureCode: s.failureCode! } })]
    : s.status === 'PENDING_REFERENCE' ? [new WagerTransactionPendingReference({ ...base, data: { ...data, referenceExternalTransactionId: s.referenceExternalTransactionId! } })]
    : [];
  if (entry) out.push(WalletBalanceChanged.from(entry, walletVersion, ids.next(), { correlationId: trace.correlationId, causationId: trace.causationId ?? base.eventId }));
  return out;
}
