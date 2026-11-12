# 04: Submit BET, WIN and LOSS over HTTP, idempotently and safely under concurrency

**What to build:** A Provider can `POST /wagering/transactions` with an `Idempotency-Key` to place a BET, credit a WIN (without a Reference), or record a LOSS, and gets back the status, the Balance and `idempotentReplay`. Retries return the original result. Concurrent submissions against one Wallet never overdraw it or double-apply. Wager Transactions can be read by internal id and by `(providerId, externalTransactionId)`. This ticket builds the single `SubmitWagerTransaction` use case that the queue will reuse later. See spec D6, D11–D16, D20–D22, ADR-0002, Requirements §7, §8, §9, §13 concurrency tests 1–3.

**Blocked by:** 03

**Status:** done

- [ ] `WagerTransaction` domain class with `create`/`rehydrate`, the transitions from D11 (a final status throws `InvalidTransactionStateError`), `affectsBalance`, `requiresReference`, `matchesPayload`
- [ ] Payload hash exactly as D14; the algorithm is written down in a code comment that ARCHITECTURE.md will copy
- [ ] Idempotency flow from D13: first insert with `ON CONFLICT DO NOTHING`, then Replay, `IDEMPOTENCY_CONFLICT` or `EXTERNAL_ID_CONFLICT`; nothing is cached in memory
- [ ] One DB transaction holds the Wallet `FOR UPDATE` with `lock_timeout = 2s`; a timeout → 503 with `Retry-After`
- [ ] BET without enough Balance → stored REJECTED `INSUFFICIENT_FUNDS`, 422, no Ledger Entry; a LOSS is PROCESSED with no Ledger Entry and no version change
- [ ] Wallet not found or player mismatch → 422 with nothing stored (D16); currency mismatch → stored REJECTED `CURRENCY_MISMATCH`
- [ ] `balance_snapshot` stored on every outcome; a Replay returns it with `idempotentReplay: true` and the status code from D20
- [ ] A no-op `AuthGuard` and `ProviderIdentityPort` are in place on these endpoints (D22)
- [ ] HTTP mapping from D20 comes from one exception filter that every endpoint shares
- [ ] Unit tests for the BET/WIN/LOSS rules, currency conflict, and same key with a different payload
- [ ] Concurrency test (real parallel connections): the same BET sent 50 times in parallel → one debit
- [ ] Concurrency test: Balance 100.00, two parallel 80.00 BETs → one PROCESSED, one REJECTED `INSUFFICIENT_FUNDS`, Balance 20.00, exactly one DEBIT entry
- [ ] Concurrency test: many Wallets in parallel all end consistent; every test ends with Balance == ledger sum
