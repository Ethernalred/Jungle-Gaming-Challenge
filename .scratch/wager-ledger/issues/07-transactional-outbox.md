# 07: Transactional outbox and event publisher

**What to build:** Every outcome emits its integration events through an outbox row written in the same DB transaction as the change, so an event exists if and only if the change committed. A publisher worker, safe to run on many instances at once, sends them to `wager-events.fifo` and survives crashes. See spec D23, D24, Requirements §11.

**Blocked by:** 05

**Status:** done

- [ ] An abstract `IntegrationEvent` with subclasses `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`; the event type and version are defined on each class; money is sent as decimal strings
- [ ] `WagerTransactionProcessed` is emitted for a LOSS too; `WalletBalanceChanged` only when the Balance changes (including OPENING)
- [ ] An outbox migration, reversible, with an index on unpublished rows
- [ ] The publisher claims rows with `FOR UPDATE SKIP LOCKED`, uses `eventId` as the deduplication id, and backs off as in D24 without ever dropping a row
- [ ] Integration test: an atomicity check shows that a failure after the ledger write leaves no Wallet change, no ledger row and no outbox row
- [ ] Integration test: two publishers on the same outbox → every event published, none lost
- [ ] Integration test: the process dies after commit and before publish → another publisher sends the event; a duplicate publish is harmless to a consumer that dedupes by `eventId`
- [ ] Integration test: SQS unavailable → rows stay pending with growing backoff, then publish once SQS is back
