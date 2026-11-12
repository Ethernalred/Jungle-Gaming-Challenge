import { WagerTransaction } from '../../domain/wager-transaction';

/** Result fields every response about a stored Wager Transaction carries (D20). */
export const resultJson = (tx: WagerTransaction, idempotentReplay: boolean) => ({
  transactionId: tx.id, status: tx.status, balance: tx.balanceSnapshot?.toJSON() ?? null, idempotentReplay,
});

/** Thrown for REJECTED / FAILED results so the one exception filter maps them to 422 / 500 (D20). */
export class WagerOutcomeError extends Error {
  constructor(readonly tx: WagerTransaction, readonly replay: boolean) { super(`Wager Transaction ${tx.status}: ${tx.failureCode}`); }
}
