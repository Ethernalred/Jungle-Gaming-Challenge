# Spec: Wager Ledger

**Source of truth:** [Requirements.md](../../Requirements.md), the challenge brief in Portuguese. This file records technical decisions referenced by tickets. Current architecture and trade-offs are in [ARCHITECTURE.md](../../ARCHITECTURE.md), terminology in [GLOSSARY.md](../../GLOSSARY.md), and lasting decisions in [docs/adr](../../docs/adr).

Tickets reference the technical decisions below as `D<n>`.

## Stack

- **D1** Bun 1.x, TypeScript strict, NestJS 11, PostgreSQL, SQS on LocalStack, Docker Compose.
- **D2** MikroORM v7 + `@mikro-orm/postgresql`, `EntitySchema` with explicit property types and an explicit entity list, domain classes free of ORM code (ADR-0004). The migrator is registered as an extension, and migrations are imported statically. The CLI always runs as `bunx --bun mikro-orm`. Decorator flags go directly in the app tsconfig (not via `extends`). No minify or bytecode builds. Add `tinyglobby`.
- **D3** Ids are UUIDv7 from an injected id generator; time comes from an injected clock (keeps tests deterministic).

## Money

- **D4** `Money` holds a `bigint` of cents plus an ISO-4217 currency (ADR-0001). It parses only `^\d+\.\d{2}$`, rejects anything else (NaN, Infinity, exponent notation, empty, >2 decimals, negatives on input), and throws a domain error on mixed currencies. DB columns: `NUMERIC(19,2)` for amounts plus `CHAR(3)` for the currency.
- **D5** The model is multi-currency; only BRL is exercised, but currency conflicts are tested.

## Wager Transactions

- **D6** Kinds and effects follow Requirements §7. A WIN may carry a Reference (to a BET in the same Round). A LOSS accepts any amount ≥ 0 and writes no Ledger Entry. All other Kinds need an amount > 0.
- **D7** Reference rules: REFUND → BET only; ROLLBACK → BET, WIN or REFUND; WIN → BET only. The Reference must match provider, player, wallet, currency and Round. Amounts must be equal. The direction of a ROLLBACK is the opposite of its Reference's direction.
- **D8** A referenced Wager Transaction has at most one Processed Reversal of either Kind (ADR-0003). This is enforced by a partial unique index on the reference where status is PROCESSED and kind is REFUND or ROLLBACK.
- **D9** Status of the Reference when resolving:

  | Reference | Outcome |
  |---|---|
  | missing (or not yet committed) | `PENDING_REFERENCE` |
  | itself `PENDING_REFERENCE` | stay `PENDING_REFERENCE` |
  | `REJECTED` / `FAILED` | `REJECTED` `REFERENCE_NOT_PROCESSED` |
  | `PROCESSED` | validate (D7, D8), then apply |

- **D10** OPENING: created with the Wallet in the same DB transaction, only when the initial Balance is > 0. `providerId = 'internal'`, `externalTransactionId = idempotencyKey = 'opening:{walletId}'`, Round and game are null. A DB check allows null Round/game only for OPENING, and allows OPENING only for provider `internal`. The API and queue reject `kind: OPENING` as invalid payload.
- **D11** Transitions: `PENDING → PROCESSED | REJECTED | PENDING_REFERENCE`; `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`. Final statuses have no exits (`InvalidTransactionStateError`). FAILED only happens in the pending-reference worker, when a stored Wager Transaction hits a non-transient, non-business error. In the normal path the whole attempt rolls back instead.
- **D12** Every Wager Transaction stores `balance_snapshot`, the Wallet Balance observed when it reached its current status. Replays return it.

## Idempotency

- **D13** The `Idempotency-Key` header (`data.idempotencyKey` on the queue) is the identity. Unique `(provider_id, idempotency_key)` and unique `(provider_id, external_transaction_id)`. The first insert uses `ON CONFLICT DO NOTHING`. On conflict, the existing row is read: same key with same hash → Replay; same key with different hash → `IDEMPOTENCY_CONFLICT`; same external id under a different key → `EXTERNAL_ID_CONFLICT`.
- **D14** Payload hash: SHA-256 hex of canonical JSON (keys sorted recursively, no whitespace) of `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId` (omitted when absent). The amount is the normalized 2-decimal string. Headers and transport fields are excluded.

## Concurrency

- **D15** One `SELECT … FOR UPDATE` on the Wallet per DB transaction (ADR-0002), with `SET LOCAL lock_timeout = '2s'`. A timeout is a transient error (HTTP 503 or SQS retry) and counts as a lock conflict. Wallet `version` starts at 1 and increments only when the Balance changes. DB checks: `balance >= 0`, unique `(player_id, currency)`.
- **D16** Wallet not found, or not owned by the given player: rejected before anything is stored (422 `WALLET_NOT_FOUND` / `WALLET_PLAYER_MISMATCH`). A currency mismatch on an existing Wallet is stored as REJECTED `CURRENCY_MISMATCH`.

## Ledger

- **D17** Ledger Entries cannot change: a trigger raises on UPDATE/DELETE, and the app role has no UPDATE/DELETE grant. Checks: `balance_after = balance_before ± amount`, unique `(wallet_id, transaction_id)`.
- **D18** Ledger pagination: order by `(created_at, id)` ascending, with an opaque cursor encoded as base64url of `createdAt|id`. `limit` defaults to 50, max 200.
- **D19** Reconciliation runs in one DB transaction holding `FOR SHARE` on the Wallet. It compares the stored Balance with the signed sum of the Ledger Entries, and returns `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`. A Divergence is logged at warn level, counted in a metric and reported, never corrected.

## HTTP

- **D20** Status mapping, the same on every endpoint. The error body is always `{ code, message }` (plus the result fields when a Wager Transaction exists).

  | Situation | Status | Code |
  |---|---|---|
  | invalid payload, missing header, `kind: OPENING` | 400 | `VALIDATION_ERROR` |
  | same key, different payload | 409 | `IDEMPOTENCY_CONFLICT` |
  | same external id, different key | 409 | `EXTERNAL_ID_CONFLICT` |
  | duplicate Wallet | 409 | `WALLET_ALREADY_EXISTS` |
  | first PROCESSED / Replay of PROCESSED | 201 / 200 | — |
  | REJECTED (stored), or wallet not found / mismatch (not stored) | 422 | the Failure Code |
  | PENDING_REFERENCE | 202 | — |
  | FAILED | 500 | `INTERNAL_ERROR` |
  | transient infra (DB down, lock timeout) | 503 + `Retry-After` | `TEMPORARILY_UNAVAILABLE` |
  | unknown resource on GET | 404 | `NOT_FOUND` |

  A Replay returns the same status as the original plus `idempotentReplay: true` (except first-PROCESSED 201 → 200).
- **D21** Failure Codes: `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`, `ALREADY_REVERSED`, `CURRENCY_MISMATCH`, `INTERNAL_ERROR`. Never stored: `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`. Each code is documented with the action the Provider should take.
- **D22** Auth is not implemented: a no-op `AuthGuard` and a `ProviderIdentityPort` mark the extension point. Health endpoints and the queue bypass it. ARCHITECTURE.md sketches a Keycloak/OIDC design.

## Messaging

- **D23** Outbox: rows are written in the same DB transaction as the change. Events: `WagerTransactionProcessed` (including LOSS), `WagerTransactionRejected`, `WalletBalanceChanged` (only when the Balance changes), `WagerTransactionPendingReference`. An abstract `IntegrationEvent` has one subclass per event, with the type and version on the class, and money carried as decimal strings.
- **D24** Outbox publisher: polls every 500 ms and claims up to 50 due rows with `FOR UPDATE SKIP LOCKED`. It publishes to `wager-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`), then marks the rows published. On failure it backs off 1 s × 2ⁿ, capped at 5 min, with no attempt limit, because confirmed events are never dropped. Known ceiling: the claim stays open during the publish call.
- **D25** Queue consumer on `wager-transactions.fifo`: long poll 20 s, batch 10, visibility 30 s. The inbox is keyed `(consumer_name, message_id)` and inserted in the same DB transaction as the change. A known messageId with the same hash → ack. A known messageId with a different hash → permanent. Error classes:
  - business → ack
  - transient → change visibility with backoff and let it retry
  - permanent (unparseable, invalid, inbox hash mismatch) → send to `wager-transactions-dlq.fifo`, then delete

  The redrive policy uses `maxReceiveCount = 5`, so a transient error that repeats lands in the DLQ. Deletion happens only after commit.
- **D26** On SIGTERM: stop polling, wait up to 10 s for in-flight messages, then set the visibility of the rest to 0.
- **D27** Pending-reference worker: polls every 1 s and claims due `PENDING_REFERENCE` rows with `SKIP LOCKED`. Backoff is 2 s × 2ⁿ, with at most 8 attempts (about 8.5 min in total). After that, the row is REJECTED `REFERENCE_NOT_FOUND` and a `WagerTransactionRejected` event is emitted. The worker re-runs the same resolution logic as a fresh submission.

## Observability

- **D28** pino JSON logs with `correlationId` (from AsyncLocalStorage, taken from an `X-Correlation-Id` header or the message, or else generated), `messageId`, `transactionId`, `walletId`, `providerId`. No amounts or full payloads. prom-client `/metrics` with: Wager Transactions by status, duplicates detected (Replays plus inbox hits), retries, DLQ messages, lock conflicts, outbox lag (age of the oldest unpublished row), processing latency, reconciliation Divergences. `GET /health/live` reports the process is up; `GET /health/ready` checks PostgreSQL and SQS.

## Scope

- **D29** Required: everything in Requirements §§2–13. Optional: the load test (`bun run test:load`), done only if there's at least a day of slack after everything else is green.
- **D30** Tests run against real PostgreSQL and LocalStack from Docker Compose, never mocks. Races use real parallelism (separate connections; separate `bun` processes for multi-instance tests). Every test ends by asserting that the Wallet Balance equals the Balance rebuilt from the ledger.
