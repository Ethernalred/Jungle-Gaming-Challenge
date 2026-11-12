# 08: Queue consumer with persistent inbox, DLQ and graceful shutdown

**What to build:** Wager Transactions can also arrive on `wager-transactions.fifo`. The consumer runs the same `SubmitWagerTransaction` use case as HTTP, records each message in a persistent inbox inside the same DB transaction, acks only after commit, and sends messages that will never succeed to the DLQ. Redelivery never doubles an effect, and SIGTERM loses no work. See spec D25, D26, Requirements §10.

**Blocked by:** 07

**Status:** done

- [ ] Inbox migration with PK `(consumer_name, message_id)` and a payload hash; the inbox row, financial change, ledger and outbox commit together
- [ ] Error classes from D25: business → ack; transient → visibility backoff; permanent → DLQ then delete; a repeating transient error reaches the DLQ via `maxReceiveCount = 5`
- [ ] A different messageId with the same Idempotency Key → Replay, no second effect
- [ ] SIGTERM: stop polling, wait for in-flight messages for up to 10 s, then give the rest back (visibility 0)
- [ ] `kind: OPENING` on the queue → permanent → DLQ
- [ ] Integration test: the same message delivered twice → one effect
- [ ] Integration test: the worker is killed after commit and before ack → the redelivered message is a no-op and the final state is consistent
- [ ] Integration test: a malformed message → DLQ; a transient DB outage → retried, then succeeds
- [ ] Integration test: SIGTERM during processing → the in-flight message finishes or becomes visible again, never half-applied
