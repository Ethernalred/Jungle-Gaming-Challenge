# Architecture

Scope: what is built, why, and where it stops. Terms follow [GLOSSARY.md](GLOSSARY.md). Binding decisions: [ADR-0001 Money](docs/adr/0001-money-as-bigint-cents.md), [ADR-0002 lock](docs/adr/0002-pessimistic-lock-per-wallet.md), [ADR-0003 one Reversal](docs/adr/0003-one-reversal-per-reference.md), [ADR-0004 MikroORM](docs/adr/0004-mikroorm-v7-entityschema.md). Additional implementation decisions: [spec.md](.scratch/wager-ledger/spec.md).

## Layers
| Layer | Holds | Rule |
|---|---|---|
| `src/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, outbox events, errors | no framework or ORM imports; invariants live in the classes (private constructors, `rehydrate` factories) |
| `src/application` | `SubmitWagerTransaction`, `resolveReference`, pending-reference worker, reconciliation, ports | one use case serves HTTP, the queue and the worker |
| `src/infrastructure` | MikroORM schemas, mappers, repositories, migrations; SQS consumer and Outbox publisher; pino, prom-client; auth port | implements the ports |
| `src/interfaces` | controllers, the one exception filter, health, metrics | thin |

## ORM, Money mapping, transaction strategy
- **ORM: MikroORM v7 with `EntitySchema`** (spec-preferred, explicit Unit of Work, `em.transactional`). No entity decorators: Bun's decorator-metadata bugs, and the domain classes stay free of ORM code ([ADR-0004](docs/adr/0004-mikroorm-v7-entityschema.md)). Entities are listed explicitly, the migrator is a registered extension, migrations are imported statically, the CLI runs as `bunx --bun mikro-orm`. TypeORM was not kept as a fallback (more decorator-dependent).
- **Money**: `bigint` cents plus ISO-4217 currency, never a `number` ([ADR-0001](docs/adr/0001-money-as-bigint-cents.md)). Parses only `^\d+\.\d{2}$`; rejects NaN, Infinity, exponents, empty, more than 2 decimals, negatives; mixed currencies throw. DB: `NUMERIC(19,2)` plus `CHAR(3)`; mappers convert through the decimal string, so no float is ever involved. API and events carry strings. Only 2-decimal currencies are supported; others need ADR-0001 revisited.
- **DB transaction strategy**: one DB transaction per submission (`em.transactional`), which takes the Wallet lock first and then does everything: idempotency insert, Wallet update, Ledger Entry, Outbox rows, Inbox row (queue). Raw SQL inside it uses `em.execute` (`em.getConnection().execute` would run outside the transaction in v7). Domain errors that mean "rejected" are stored and committed; transient and unknown errors roll the whole attempt back.
- **Constraints as a second line**: `balance >= 0`; unique `(player_id, currency)`; Ledger Entry `balance_after = balance_before ± amount` and unique `(wallet_id, transaction_id)`; immutable Ledger Entries (trigger raises on UPDATE/DELETE, and the app role `jungle_app` has no UPDATE/DELETE grant on them, D17); partial unique index for one processed Reversal per Reference; null Round/game only for OPENING, OPENING only for provider `internal`.

## Concurrency
- **Choice ([ADR-0002](docs/adr/0002-pessimistic-lock-per-wallet.md))**: `SELECT … FOR UPDATE` on the one Wallet row per DB transaction, `SET LOCAL lock_timeout = '2s'`. Ledger Entries need exact before/after Balances, so the Balance is read under control anyway. One lock per DB transaction means no lock-order deadlocks; different Wallets never block each other; it works across any number of app instances because the lock is in PostgreSQL. A lock timeout is transient (HTTP 503, SQS retry) and increments `lock_conflicts_total`. Wallet `version` starts at 1 and rises only when the Balance changes.
- **Rejected alternatives**: optimistic `version` with retry (retries pile up on a hot Wallet); a single conditional `UPDATE … WHERE balance >= x RETURNING` (correct, but before/after values and Reference checks get awkward); an in-process mutex (fails with several instances, an eliminatory fault).
- Reconciliation takes `FOR SHARE` on the Wallet, so it sees a state no write is half-way through.

## Idempotency
- Identity: the `Idempotency-Key` header (`data.idempotencyKey` on the queue). Unique `(provider_id, idempotency_key)` and unique `(provider_id, external_transaction_id)`, in PostgreSQL, so it survives restarts and works across instances.
- Flow: lock the Wallet, compute the outcome, insert the final row `ON CONFLICT DO NOTHING`. On conflict read the existing row: same key and same hash gives a Replay; same key, different hash gives `IDEMPOTENCY_CONFLICT`; same external id under another key gives `EXTERNAL_ID_CONFLICT`. The Wallet lock serializes concurrent duplicates.
- **Hash**: SHA-256 hex of canonical JSON (keys sorted recursively, no whitespace, undefined dropped) of `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}` and `referenceExternalTransactionId` when present. The amount is the normalized 2-decimal string. Headers and transport fields are excluded. Code: `payloadHash` in `src/domain/wager-transaction.ts`.
- A Replay returns the original status and the Balance observed then (`balance_snapshot`, D12), with `idempotentReplay: true`; a first PROCESSED answers 201, its Replay 200.

## Wager Transaction life cycle
| From | To | When |
|---|---|---|
| PENDING | PROCESSED | rules pass, Balance updated, Ledger Entry written |
| PENDING | REJECTED | business rule broken (Failure Code stored) |
| PENDING | PENDING_REFERENCE | Reference not yet known |
| PENDING_REFERENCE | PROCESSED / REJECTED | worker re-resolves with the same logic as a fresh submission |
| PENDING_REFERENCE | FAILED | worker hits a non-transient, non-business error (`INTERNAL_ERROR`) |

PROCESSED, REJECTED, FAILED are final; any exit throws `InvalidTransactionStateError`. In the normal path an unexpected error rolls the attempt back instead of storing FAILED. Kinds: BET debits (needs funds); WIN credits; LOSS is PROCESSED with no Ledger Entry and no Balance change; REFUND credits; ROLLBACK is the opposite direction of its Reference; OPENING is internal.

Reference resolution (D9, in this order): Wallet currency, then the Reference's Status (missing or itself pending: stay PENDING_REFERENCE; REJECTED/FAILED: `REFERENCE_NOT_PROCESSED`), then provider/player/wallet/currency/Round match, Kind, amount, already reversed, overdraw. Allowed References: REFUND to BET; ROLLBACK to BET, WIN or REFUND; WIN to BET.

### Failure Codes: what the Provider should do
Rejections are final: resending the same key returns the same rejection (Replay). "Resend" below means a new submission with a new key and external id, unless stated.

| Code | Stored | Cause | Provider action |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | yes, 422 | BET larger than Balance | give up on this BET (tell the Player); after a top-up submit a new BET with new ids |
| `REVERSAL_WOULD_OVERDRAW` | yes, 422 | ROLLBACK of a credit would push Balance below 0 | give up automatically; needs manual handling, do not retry |
| `REFERENCE_NOT_FOUND` | yes, 422 | Reference never arrived within 8 attempts (~8.5 min) | send the missing original first, then resend the Reversal with a new key; otherwise give up |
| `REFERENCE_NOT_PROCESSED` | yes, 422 | Reference exists but is REJECTED or FAILED | give up: there is nothing to reverse |
| `REFERENCE_MISMATCH` | yes, 422 | Reference has another provider, player, Wallet, currency or Round | fix the request, resend with a new key |
| `INVALID_REFERENCE_KIND` | yes, 422 | e.g. REFUND of a WIN, WIN of a REFUND | fix the request, resend with a new key |
| `AMOUNT_MISMATCH` | yes, 422 | a REFUND/ROLLBACK amount differs from the Reference (no partial Reversals) | fix the amount to equal the Reference, resend with a new key |
| `ALREADY_REVERSED` | yes, 422 | the Reference already has a processed Reversal (ADR-0003) | give up: it is done; read the earlier result |
| `CURRENCY_MISMATCH` | yes, 422 | currency differs from the Wallet's | fix the currency, resend with a new key |
| `INTERNAL_ERROR` | yes (FAILED), 500 | permanent error in the pending-reference worker | do not loop; escalate with `transactionId`. A Replay returns the same 500 |
| `WALLET_NOT_FOUND` | no, 422 | unknown Wallet | fix `walletId`; same key may be reused, nothing was stored |
| `WALLET_PLAYER_MISMATCH` | no, 422 | Wallet belongs to another Player | fix `playerId`/`walletId`; same key may be reused |

Non-code outcomes:

| Response | Provider action |
|---|---|
| 400 `VALIDATION_ERROR` | fix the payload or header; nothing stored |
| 409 `IDEMPOTENCY_CONFLICT` | you reused a key with a different body: send the original body, or use a new key |
| 409 `EXTERNAL_ID_CONFLICT` | the external id was already sent under another key: reuse that key |
| 202 PENDING_REFERENCE | do not resend; poll `GET` or wait for the event; it ends PROCESSED or REJECTED `REFERENCE_NOT_FOUND` |
| 503 `TEMPORARILY_UNAVAILABLE` + `Retry-After` | resend the same key and body after the delay |
| 404 `NOT_FOUND` | no such Wallet or Wager Transaction |

## HTTP mapping (D20)
Body on errors is always `{ code, message }`, plus `transactionId, status, balance, idempotentReplay` when a Wager Transaction exists. One exception filter does the mapping.

| Situation | Status | Code |
|---|---|---|
| invalid payload, missing header, `kind: OPENING` | 400 | `VALIDATION_ERROR` |
| same key, different payload / same external id, different key / duplicate Wallet | 409 | `IDEMPOTENCY_CONFLICT` / `EXTERNAL_ID_CONFLICT` / `WALLET_ALREADY_EXISTS` |
| first PROCESSED / Replay of PROCESSED | 201 / 200 | none |
| REJECTED, or Wallet unknown / mismatch (not stored) | 422 | the Failure Code |
| PENDING_REFERENCE | 202 | none |
| FAILED | 500 | `INTERNAL_ERROR` |
| DB down, lock timeout | 503 + `Retry-After: 1` | `TEMPORARILY_UNAVAILABLE` |
| unknown resource on GET | 404 | `NOT_FOUND` |

## Messaging
| Part | Behaviour |
|---|---|
| **Outbox** (D23, D24) | Rows written in the same DB transaction as the change, so an event exists if and only if the change committed; nothing is published before commit. Events: `WagerTransactionProcessed` (also LOSS and OPENING), `WagerTransactionRejected`, `WalletBalanceChanged` (only when the Balance moves), `WagerTransactionPendingReference`. Money as decimal strings; `eventId` for consumer dedup; `correlationId`, `causationId`. Publisher polls every 500 ms, claims up to 50 due rows `FOR UPDATE SKIP LOCKED` (so several instances share work), sends to `wager-events.fifo` (`MessageGroupId` = Wallet id, `MessageDeduplicationId` = eventId), then marks published. On failure the row backs off 1 s x 2^n capped at 5 min, with no attempt limit: confirmed events are never dropped. |
| **Inbox** (D25) | Keyed `(consumer_name, message_id)`, inserted in the same DB transaction as the change. Known id with same hash: ack, nothing changes. Known id with different hash: permanent. |
| **Consumer** (D25, D26) | `wager-transactions.fifo`, long poll 20 s, batch 10, visibility 30 s, one message at a time (keeps order inside a group). The message is deleted only after commit. Business error (a Rejected outcome, domain rule): ack. Transient error: change visibility with backoff and let SQS redeliver; after `maxReceiveCount = 5` the redrive policy moves it to the DLQ. Permanent (unparseable, invalid, `OPENING`, inbox hash mismatch): send to `wager-transactions-dlq.fifo`, then delete. SIGTERM: stop polling, wait up to 10 s for the in-flight message, then set the rest to visibility 0. |
| **Crash recovery** | Crash after commit before delete: redelivery hits the Inbox and acks. Crash before commit: nothing stored, redelivery processes it. Publisher dies after claim: the claim rolls back with the connection, another instance picks the rows up. All proven with real child processes in `test/multi-instance`. |
| **Pending-reference worker** (D27) | Polls every 1 s, claims due `PENDING_REFERENCE` rows `SKIP LOCKED`, re-runs the same resolution as a fresh submission. First retry is due 2 s after creation, then 2 s x 2^n; the 8th failed attempt rejects: 510 s, about 8.5 min, then REJECTED `REFERENCE_NOT_FOUND` plus a `WagerTransactionRejected` event. Why bounded: a Reference that has not shown up in 8.5 min is more likely lost than late, and an unbounded wait hides a Provider bug and keeps a Round open; why so long: queues and Provider retries reorder by seconds to minutes. A REFUND pending on a Wallet does not block later BETs: they proceed normally. |

## Observability
pino JSON logs with `correlationId` (AsyncLocalStorage; from `X-Correlation-Id` or the message, else generated; echoed in the response header), `messageId`, `transactionId`, `walletId`, `providerId`; amounts and payloads redacted. `/metrics` (prom-client): see README. `/health/live` is the process; `/health/ready` checks PostgreSQL and SQS. A Divergence is logged at warn, counted, returned by Reconciliation and never auto-corrected.

## Load test
`bun run test:load` ([docs/load-test.md](docs/load-test.md): environment, method, full table of the last run). 3 instances, round-robin, 1000 BETs per step, client concurrency capped at 32. Five consecutive runs, one machine (16 logical cores, Ryzen 7 5700X3D) shared by the client, 3 apps, PostgreSQL and LocalStack:
- **Hot Wallet ceiling**: throughput is about 220-270 req/s at concurrency 1, reaches 290-410 req/s at concurrency 4 and then stays there (290-410 at 16 and 32) while p50 grows with concurrency (in the committed run p50 was 10 ms at 4, 46 ms at 16, 79 ms at 32; p99 across the five runs 17-44 ms at 4 and 100-155 ms at 32). More clients only queue. This is the serialized per-Wallet `SELECT ... FOR UPDATE` ([ADR-0002](docs/adr/0002-pessimistic-lock-per-wallet.md)): one DB transaction at a time per Wallet, so a hot Wallet is bounded by one transaction's latency, not by CPU or instances. Run-to-run spread is large (for example 290-406 req/s at concurrency 4), so only the shape is reliable, not single numbers.
- **Spread vs hot**: the same 1000 requests over 200 Wallets ran at 1620-2730 req/s (concurrency 16 and 32) with p99 16-53 ms, roughly 4-7 times the hot Wallet, because different Wallets do not block each other.
- **Conflicts and errors**: 0 errors (no 5xx, no timeouts) and 0 `lock_conflicts_total` in all 30 steps. The worst hot-Wallet wait (p99 about 155 ms) is far below `lock_timeout` 2 s, so the experiment never reached the point where 503 starts; it shows the ceiling, not the failure mode. A 503 test would need concurrency above the 32 cap or slower transactions.
- **Outbox lag**: commit-to-publish p50 about 2-3 s and max 4-6 s for hot steps, p50 about 5 s and max 9 s for spread steps. The publisher drains at a bounded rate, so lag is the backlog of an ingest that is faster than publishing (spread ingests about 2000 events/s), and it is measured after the burst, not steady state. Lag is not a latency of the HTTP path.
- **Correctness**: after every step all touched Wallets were Reconciled `consistent: true` and Balance == initial funds minus accepted BETs.
- **What limits the measurement**: everything shares one machine, so client, apps and database compete for cores (lower bound, not capacity); one run is 1000 requests per step (short, no warm-up discarded); client-side latency includes the load client's own event loop; only BET on funded Wallets (no rejections, Reversals or duplicates); Bun and PostgreSQL defaults, no tuning; pool sizes were not varied.

## Authentication (not implemented, by choice)
Auth carries no points and must not compete with financial correctness (Requirements §2). A no-op `AuthGuard` on the wagering controller and a `ProviderIdentityPort` (`src/infrastructure/auth/provider-identity.ts`) mark the extension point; `/health*`, `/metrics` and the queue bypass it.

Design I would adopt: **Keycloak (OIDC)**, one confidential client per Provider using the client-credentials grant, with the `providerId` as a claim or client attribute. The `ProviderIdentityPort` verifies the bearer JWT (signature against the realm's JWKS, `iss`, `aud`, `exp`) and returns `{ providerId }`. The guard then rejects 401 (no or bad token) and 403 when the body or path `providerId` differs from the token's, so a Provider cannot touch another Provider's Wager Transactions. Wallet endpoints get an admin scope. Keycloak joins `docker-compose.yml`; no user table or password hashing in this service. Queue messages remain a trusted internal channel, but their `providerId` still passes the same domain validation.

## Interpretations
| Topic | Choice |
|---|---|
| Reversal | one processed Reversal per Reference, by either Kind (REFUND and ROLLBACK together), via a partial unique index ([ADR-0003](docs/adr/0003-one-reversal-per-reference.md)); a ROLLBACK of a REFUND is allowed (it references the REFUND) |
| WIN with a Reference | must point at a BET and waits like a Reversal (PENDING_REFERENCE) if the BET is unknown; its amount may differ from the BET (a payout), only REFUND/ROLLBACK must equal their Reference (Requirements §7 rule 5) |
| LOSS | any amount >= 0, writes no Ledger Entry, still emits Processed |
| OPENING | created with the Wallet in the same DB transaction, only when the initial Balance > 0; `providerId = internal`, ids `opening:{walletId}`, Round and game null; the API and queue reject `kind: OPENING` |
| Currency | model is multi-currency (Money, one Wallet per Player and currency, conflict tests); only BRL is exercised |
| Partial Reversals | not supported: amount must equal the Reference (`AMOUNT_MISMATCH`) |
| Wallet/Player mismatch | rejected before storing anything (422), unlike a currency mismatch which is stored |
| Zero opening | no OPENING row and no events |

## Limitations
- **Hot Wallet ceiling**: all writes to one Wallet serialize on its row lock ([ADR-0002](docs/adr/0002-pessimistic-lock-per-wallet.md)); throughput per Wallet is about one DB transaction at a time. Different Wallets scale out. A lock wait over 2 s turns into 503/retry.
- **Outbox polling latency**: events reach consumers up to ~500 ms after commit, longer after a publish failure (backoff up to 5 min).
- **Claim held open during publish**: the publisher keeps its `SKIP LOCKED` claim transaction open while calling SQS; a slow SQS holds those rows (and a DB connection) for that time. Ordering per Wallet is kept within a claimed batch only.
- **At-least-once delivery**: a crash between SQS send and marking published re-sends the event. FIFO deduplication (`eventId`, 5-minute window) helps; consumers must dedupe on `eventId`.
- Consumer handles one message at a time (no parallel groups); queue throughput is bounded by that.
- Pending Reversals older than 8.5 min are rejected even if the original arrives later; the Provider must resend.
- Only 2-decimal currencies; no partial Reversals; no auth.

## Known deviations (code vs. spec)
| Spec | Built |
|---|---|
| FAILED could be expected to emit an event | no event for FAILED (D23 lists none); the stored row is the audit trail |
| D28 amounts in a Divergence log | removed (logs carry no amounts); amounts are in the Reconciliation response |
| D24 ordering | kept per claimed batch only; a failed row backs off and later rows of the same Wallet in that batch are skipped |
| Pending-reference worker correlation | a fresh `correlationId` per attempt (the original is not stored); trace by `transactionId` |
| Order of Reference checks | Wallet currency, Status, match, Kind, amount, reversed, overdraw (D9 and D7 do not fix a full order) |
| A Reference found as plain PENDING | treated like PENDING_REFERENCE (cannot occur under the Wallet lock) |
| Invalid UUID on `GET` | 404 `NOT_FOUND` (it can never exist); non-UUID `walletId`/`playerId` on POST: 400 |
| `Retry-After` | fixed 1 s |
| Queue event `causationId` | the body `messageId` (not the SQS MessageId) |
