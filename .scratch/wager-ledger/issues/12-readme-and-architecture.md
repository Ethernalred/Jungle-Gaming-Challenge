# 12: README and ARCHITECTURE.md

**What to build:** A reviewer can set up, run and test the project from README.md alone, and can understand every graded decision, trade-off and limitation from ARCHITECTURE.md. Cover prerequisites, setup, migrations, test commands, ports, and HTTP examples. See spec D1–D30, ADRs 0001–0004, Requirements §2, §4, §7, §14.

**Blocked by:** 10, 11

**Status:** done

- [ ] README: prerequisites, `docker compose up`, migrate up/down, run, every `bun test` variant, ports, example curl commands (create Wallet, the 2×80 race, a Replay, Reconciliation)
- [ ] ARCHITECTURE.md: the ORM choice, how `Money` is mapped and the DB transaction strategy (required by Requirements §4); the locking choice and rejected alternatives; idempotency and the hash algorithm; the transition table; the Failure Code table with what the Provider should do for each; the HTTP mapping; outbox, inbox and queue error handling; pending-reference limits and why; the auth design (Keycloak/OIDC sketch plus the extension point)
- [ ] Interpretations listed: one Reversal per Reference (ADR-0003), WIN with a Reference waits like a Reversal, LOSS amount ≥ 0, OPENING fields, single BRL but multi-currency model, no partial Reversals
- [ ] Limitations listed: the throughput ceiling of a hot Wallet, outbox polling latency, the claim held open during publish, at-least-once delivery to downstream consumers
