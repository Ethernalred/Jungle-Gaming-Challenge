# Wager Ledger

Keeps player wallet balances correct while game providers send betting operations that may arrive duplicated, out of order, or simultaneously.

## Parties

**Provider**:
An external game provider that submits operations on behalf of players.
_Avoid_: Operator, partner, client

**Player**:
The person whose money is held in a Wallet. Identified by the Provider-independent player id.
_Avoid_: User, customer, account

**Round**:
One play of a game, grouping a BET with the operations that settle or reverse it.
_Avoid_: Session, hand, spin

## Money

**Wallet**:
A Player's balance in one currency. At most one per Player per currency.
_Avoid_: Account, purse

**Balance**:
The amount currently held in a Wallet. Never negative.

**Ledger Entry**:
An immutable record of one change to a Wallet's Balance, with the Balance before and after it.
_Avoid_: Transaction, movement, posting

## Operations

**Wager Transaction**:
One operation submitted by a Provider (or created internally) against a Wallet. Always say "Wager Transaction", never bare "transaction".
_Avoid_: Transaction, operation, request

**DB transaction**:
A single atomic unit of work in the database. Not a domain concept; named here only to keep it apart from Wager Transaction.

**Kind**:
What a Wager Transaction does: BET (debit), WIN (credit), LOSS (records a result, moves nothing), REFUND (returns a BET's stake), ROLLBACK (undoes a BET, WIN or REFUND), OPENING (internal credit of a new Wallet's initial Balance).

**Reference**:
The earlier Wager Transaction that a REFUND, ROLLBACK or WIN points at, named by the Provider's own id for it.

**Reversal**:
A REFUND or ROLLBACK. A referenced Wager Transaction can be reversed at most once, by either Kind.

**Status**:
Where a Wager Transaction stands: Pending, Pending Reference (waiting for its Reference to arrive), Processed, Rejected (broke a business rule) or Failed (permanent infrastructure error). The last three are final.

**Failure Code**:
A stable, machine-readable reason attached to a Rejected or Failed Wager Transaction, telling the Provider whether to resend, fix, or give up.

## Idempotency

**Idempotency Key**:
The Provider-supplied identity of a submission, scoped to the Provider. Required: the `Idempotency-Key` header over HTTP (400 without it), `data.idempotencyKey` on the queue. A common choice is `{providerId}:{externalTransactionId}`, but nothing derives it.

**Replay**:
A repeat of an already-seen submission with the same Idempotency Key and payload; it returns the original result, including the Balance observed then.
_Avoid_: Retry, duplicate

**Idempotency Conflict**:
A submission that reuses an Idempotency Key, or an external transaction id, with a different payload or key. Rejected, never treated as a Replay.

## Auditing

**Reconciliation**:
Comparing a Wallet's stored Balance with the Balance rebuilt from its Ledger Entries.

**Divergence**:
A Reconciliation where the two Balances differ. Reported, never silently corrected.

## Events

**Correlation Id**:
The id that ties one request or queue message to every log line and Integration Event it causes. Taken from the caller (header or message) or generated. An event's causation id is the queue message that caused it, when there is one.

**Outbox**:
The record of integration events written in the same DB transaction as the change that caused them, so an event exists if and only if the change committed. Published to consumers afterwards, at least once.

**Integration Event**:
A fact about a Wager Transaction or Wallet sent to other systems: Processed (also for a LOSS), Rejected, Pending Reference, or Wallet Balance Changed (only when the Balance moves). Identified by its eventId, which consumers use to ignore duplicates.

**Inbox**:
The persistent record of queue messages already handled, written in the same DB transaction as their effect, so a redelivered message changes nothing.

**DLQ**:
The dead-letter queue: where a message goes when it can never succeed or keeps failing; set aside, never retried by the consumer.
