# 05: REFUND and ROLLBACK with Reference resolution

**What to build:** A Provider can reverse an earlier Wager Transaction: a REFUND returns a BET's stake, and a ROLLBACK undoes a BET, WIN or REFUND. Each referenced Wager Transaction can be reversed at most once. A WIN may also reference its BET. When the Reference hasn't arrived yet, the submission is stored as PENDING_REFERENCE and answered with 202 (the retry worker comes in 09). See spec D6–D9, D21, ADR-0003, Requirements §7 rules 1–9.

**Blocked by:** 04

**Status:** done

- [ ] The Reference is looked up by `(providerId, referenceExternalTransactionId)` and must match provider, player, wallet, currency and Round → otherwise REJECTED `REFERENCE_MISMATCH`
- [ ] Kind rules from D7 → `INVALID_REFERENCE_KIND`; amount not equal → `AMOUNT_MISMATCH`; already reversed → `ALREADY_REVERSED`, with the D8 index as the DB backstop
- [ ] Reference status handling exactly as D9 (missing or pending → PENDING_REFERENCE, 202; REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`)
- [ ] A ROLLBACK of a WIN that would overdraw → REJECTED `REVERSAL_WOULD_OVERDRAW` (distinct from `INSUFFICIENT_FUNDS`), stored and auditable
- [ ] A ROLLBACK of a REFUND is allowed and debits; after it, the BET can't be refunded again
- [ ] `ledgerDirectionFor(reference)` gives the opposite of the Reference's direction for ROLLBACK
- [ ] Unit tests for every REFUND/ROLLBACK/WIN-with-reference rule; an integration test where BET → REFUND → ROLLBACK of the BET is rejected `ALREADY_REVERSED`
- [ ] A Replay of a PENDING_REFERENCE submission returns 202 with `idempotentReplay: true`
