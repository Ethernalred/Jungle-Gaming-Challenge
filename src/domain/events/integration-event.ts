import { LedgerDirection, WalletLedgerEntry } from '../ledger-entry';
import { MoneyProps } from '../money';
import { Kind } from '../wager-transaction';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string; // the Wallet id (SQS MessageGroupId)
  correlationId: string; // the request's / message's correlationId (D28)
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(p: IntegrationEventProps<T>) {
    this.eventId = p.eventId; this.aggregateId = p.aggregateId; this.correlationId = p.correlationId;
    this.causationId = p.causationId; this.occurredAt = p.occurredAt; this.data = p.data;
  }

  /** The envelope stored in the outbox payload and sent to the queue. Money is always a decimal string. */
  toJSON() {
    return {
      eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId, correlationId: this.correlationId,
      causationId: this.causationId, occurredAt: this.occurredAt.toISOString(), version: this.version, data: this.data as T,
    };
  }
}

/** The Wager Transaction facts every outcome event carries. */
export interface WagerOutcomeData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  kind: Kind;
  money: MoneyProps;
  balance: MoneyProps; // Wallet Balance observed at this outcome
}
export interface RejectedData extends WagerOutcomeData { failureCode: string }
export interface PendingReferenceData extends WagerOutcomeData { referenceExternalTransactionId: string }
export interface WalletBalanceChangedData {
  walletId: string; transactionId: string; direction: LedgerDirection; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number;
}

type Props<T> = Omit<IntegrationEventProps<T>, 'aggregateId'>;
const wrap = <T extends WagerOutcomeData>(p: Props<T>) => ({ ...p, aggregateId: p.data.walletId });

export class WagerTransactionProcessed extends IntegrationEvent<WagerOutcomeData> { // also for LOSS
  readonly eventType = 'WagerTransactionProcessed'; readonly version = 1;
  constructor(p: Props<WagerOutcomeData>) { super(wrap(p)); }
}
export class WagerTransactionRejected extends IntegrationEvent<RejectedData> {
  readonly eventType = 'WagerTransactionRejected'; readonly version = 1;
  constructor(p: Props<RejectedData>) { super(wrap(p)); }
}
export class WagerTransactionPendingReference extends IntegrationEvent<PendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference'; readonly version = 1;
  constructor(p: Props<PendingReferenceData>) { super(wrap(p)); }
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged'; readonly version = 1;
  constructor(p: Props<WalletBalanceChangedData>) { super({ ...p, aggregateId: p.data.walletId }); }
  static from(entry: WalletLedgerEntry, walletVersion: number, eventId: string, trace: { correlationId: string; causationId?: string }): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId, ...trace, occurredAt: entry.createdAt,
      data: {
        walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction, money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion,
      },
    });
  }
}
