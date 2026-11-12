import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/** D28: one registry per process. Names are the contract of /metrics. */
export const registry = new Registry();
const counter = (name: string, help: string, labelNames: string[] = []) => new Counter({ name, help, labelNames, registers: [registry] });

export const wagerTransactions = counter('wager_transactions_total', 'Wager Transactions stored, by Status', ['status']);
export const duplicates = counter('duplicates_detected_total', 'Replays and inbox hits', ['source']);
export const retries = counter('retries_total', 'Retries: queue redelivery, outbox send, pending-reference attempt', ['source']);
export const dlqMessages = counter('dlq_messages_total', 'Messages the consumer sent to the DLQ');
export const lockConflicts = counter('lock_conflicts_total', 'Wallet lock timeouts and deadlocks');
export const divergences = counter('reconciliation_divergences_total', 'Reconciliation Divergences found');
export const outboxLag = new Gauge({ name: 'outbox_lag_seconds', help: 'Age of the oldest unpublished outbox row', registers: [registry] });
export const processingSeconds = new Histogram({ name: 'processing_duration_seconds', help: 'Wager Transaction processing time', registers: [registry] });
