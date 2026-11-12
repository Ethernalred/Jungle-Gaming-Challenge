# 10: Structured logs and metrics

**What to build:** An operator can trace any Wager Transaction across HTTP, queue, worker and publisher by `correlationId` in JSON logs that contain no amounts or payloads, and can watch the system's health on `/metrics`. See spec D28, Requirements §12.

**Blocked by:** 06, 08, 09

**Status:** done

- [ ] pino JSON logs carry `correlationId` (from AsyncLocalStorage, taken from `X-Correlation-Id`, the message, or else generated), `messageId`, `transactionId`, `walletId`, `providerId` wherever they're known
- [ ] Redaction: no amounts, balances or full payloads in logs; a test asserts this on a captured log line
- [ ] Events carry the request's `correlationId`, with `causationId` set to the messageId when the event came from the queue
- [ ] Metrics on `/metrics`: Wager Transactions by status, duplicates detected, retries, DLQ messages, lock conflicts, outbox lag, processing latency, reconciliation Divergences
- [ ] An integration test scrapes `/metrics` after a known scenario and checks that the counters moved
