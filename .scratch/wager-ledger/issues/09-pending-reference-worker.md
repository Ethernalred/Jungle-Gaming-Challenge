# 09: Retry worker for out-of-order References

**What to build:** A REFUND, ROLLBACK or WIN that arrived before its Reference is retried automatically with exponential backoff. It applies once the Reference shows up, and after the attempt limit it is rejected as `REFERENCE_NOT_FOUND` and an event is published. Safe with many instances. See spec D9, D11 (FAILED), D27, Requirements §7.1.

**Blocked by:** 05, 07

**Status:** done

- [ ] The worker claims due PENDING_REFERENCE rows with `SKIP LOCKED`, re-runs the same resolution logic as a fresh submission, and backs off 2 s × 2ⁿ, at most 8 attempts
- [ ] Out of attempts → REJECTED `REFERENCE_NOT_FOUND` and a `WagerTransactionRejected` event in the same DB transaction
- [ ] A non-transient, non-business error → FAILED `INTERNAL_ERROR`, stored and auditable
- [ ] The clock is injected, so tests advance time instead of sleeping
- [ ] Integration test: a ROLLBACK delivered before its BET (both over HTTP and over the queue) → PENDING_REFERENCE, then PROCESSED after the BET lands; Balance == ledger
- [ ] Integration test: the Reference never arrives → REJECTED `REFERENCE_NOT_FOUND`, event published
- [ ] Integration test: two workers running → each row is processed once
