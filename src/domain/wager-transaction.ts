import { createHash } from 'node:crypto';
import { InvalidTransactionStateError, ValidationError } from './errors';
import { Money } from './money';

export const KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type Kind = (typeof KINDS)[number];
export type Status = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type FailureCode =
  | 'INSUFFICIENT_FUNDS' | 'REVERSAL_WOULD_OVERDRAW' | 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_PROCESSED' | 'REFERENCE_MISMATCH'
  | 'INVALID_REFERENCE_KIND' | 'AMOUNT_MISMATCH' | 'ALREADY_REVERSED' | 'CURRENCY_MISMATCH' | 'INTERNAL_ERROR';

/**
 * Payload hash algorithm (D14), for ARCHITECTURE.md:
 *   1. Take the business fields: providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
 *      money{amount, currency} (amount is the normalized 2-decimal string) and referenceExternalTransactionId
 *      (omitted when absent). Headers (Idempotency-Key) and transport fields are excluded.
 *   2. Serialize as canonical JSON: object keys sorted recursively, no whitespace, undefined values dropped.
 *   3. payloadHash = SHA-256 of that string, lowercase hex.
 */
export function payloadHash(fields: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const parts = Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(v);
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  playerId: string;
  walletId: string;
  roundId: string | null;
  gameId: string | null;
  kind: Kind;
  status: Status;
  failureCode: FailureCode | null;
  money: Money;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balanceSnapshot: Money | null; // D12: Wallet Balance observed when it reached its current status
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewWagerTransaction {
  id: string;
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
  at: Date;
}

const FINAL: Status[] = ['PROCESSED', 'REJECTED', 'FAILED'];

export class WagerTransaction {
  private constructor(private s: WagerTransactionState) {}

  static create(p: NewWagerTransaction): WagerTransaction {
    if (!KINDS.includes(p.kind as Kind) || p.kind === 'OPENING') throw new ValidationError(`Invalid kind: ${p.kind}`);
    for (const [name, v] of Object.entries({ providerId: p.providerId, externalTransactionId: p.externalTransactionId, playerId: p.playerId, walletId: p.walletId, roundId: p.roundId, gameId: p.gameId, idempotencyKey: p.idempotencyKey })) {
      if (typeof v !== 'string' || v.trim() === '') throw new ValidationError(`${name} is required`);
    }
    if (p.referenceExternalTransactionId !== undefined && (typeof p.referenceExternalTransactionId !== 'string' || p.referenceExternalTransactionId === '')) {
      throw new ValidationError('referenceExternalTransactionId must be a non-empty string');
    }
    const kind = p.kind as Kind;
    if ((kind === 'REFUND' || kind === 'ROLLBACK') && p.referenceExternalTransactionId === undefined) throw new ValidationError('referenceExternalTransactionId is required'); // Requirements §7 rule 1
    if (p.money.isNegative() || (!p.money.isPositive() && kind !== 'LOSS')) throw new ValidationError('amount must be > 0 (LOSS: >= 0)'); // D6
    return new WagerTransaction({
      id: p.id, providerId: p.providerId, externalTransactionId: p.externalTransactionId, idempotencyKey: p.idempotencyKey,
      payloadHash: payloadHash({
        providerId: p.providerId, externalTransactionId: p.externalTransactionId, playerId: p.playerId, walletId: p.walletId,
        roundId: p.roundId, gameId: p.gameId, kind, money: p.money.toJSON(), referenceExternalTransactionId: p.referenceExternalTransactionId,
      }),
      playerId: p.playerId, walletId: p.walletId, roundId: p.roundId, gameId: p.gameId, kind, status: 'PENDING', failureCode: null,
      money: p.money, referenceExternalTransactionId: p.referenceExternalTransactionId ?? null, referenceTransactionId: null,
      balanceSnapshot: null, processedAt: null, createdAt: p.at, updatedAt: p.at,
    });
  }

  /** Reconstruction from persistence; no revalidation. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...s });
  }

  get state(): Readonly<WagerTransactionState> { return this.s; }
  get id() { return this.s.id; }
  get status() { return this.s.status; }
  get kind() { return this.s.kind; }
  get money() { return this.s.money; }
  get failureCode() { return this.s.failureCode; }
  get balanceSnapshot() { return this.s.balanceSnapshot; }
  get payloadHash() { return this.s.payloadHash; }
  get idempotencyKey() { return this.s.idempotencyKey; }

  /** Everything but LOSS moves the Balance. */
  get affectsBalance(): boolean { return this.s.kind !== 'LOSS'; }
  /** REFUND and ROLLBACK must name a Reference (a WIN may, D6). */
  get requiresReference(): boolean { return this.s.kind === 'REFUND' || this.s.kind === 'ROLLBACK'; }

  matchesPayload(hash: string): boolean { return this.s.payloadHash === hash; }

  markProcessed(snapshot: Money, at: Date): void {
    this.to('PROCESSED', ['PENDING', 'PENDING_REFERENCE'], snapshot, at);
    this.s.processedAt = at;
  }

  reject(code: FailureCode, snapshot: Money, at: Date): void {
    this.to('REJECTED', ['PENDING', 'PENDING_REFERENCE'], snapshot, at);
    this.s.failureCode = code;
  }

  /** Records which stored Wager Transaction the Reference resolved to (the D8 index is on this). */
  linkReference(referenceTransactionId: string): void {
    this.s.referenceTransactionId = referenceTransactionId;
  }

  markPendingReference(snapshot: Money, at: Date): void {
    this.to('PENDING_REFERENCE', ['PENDING'], snapshot, at);
  }

  /** Only the pending-reference worker fails a stored Wager Transaction (D11). */
  fail(code: FailureCode, snapshot: Money, at: Date): void {
    this.to('FAILED', ['PENDING_REFERENCE'], snapshot, at);
    this.s.failureCode = code;
  }

  private to(next: Status, from: Status[], snapshot: Money, at: Date): void {
    if (FINAL.includes(this.s.status) || !from.includes(this.s.status)) {
      throw new InvalidTransactionStateError(`Cannot go from ${this.s.status} to ${next}`);
    }
    this.s.status = next;
    this.s.balanceSnapshot = snapshot;
    this.s.updatedAt = at;
  }
}
