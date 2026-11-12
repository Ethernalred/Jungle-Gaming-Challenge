# Concurrency is a pessimistic row lock on the Wallet

Every balance-changing DB transaction takes `SELECT … FOR UPDATE` on the one Wallet row it touches, with a 2-second lock timeout reported as a transient error. Ledger Entries need the exact Balance before and after, so we must read the Balance under control anyway; locking the row is the simplest correct way, and one lock per DB transaction rules out lock-order deadlocks. Wallets lock independently, so there is no global lock.

## Considered Options

- Optimistic locking on `version` with bounded retry: degrades badly on hot wallets, where retries pile up.
- Conditional atomic `UPDATE … WHERE balance >= x RETURNING`: correct, but deriving before/after values and reversal checks gets awkward.

## Consequences

A hot wallet's throughput is capped by one DB transaction at a time. Documented as a known limitation.
