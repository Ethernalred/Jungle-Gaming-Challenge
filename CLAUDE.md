# Repository conventions

Tickets live in `.scratch/<feature>/issues/`; update their status directly using [the ticket workflow](docs/development/issue-tracker.md).

Use [Requirements.md](Requirements.md) for scope, [ARCHITECTURE.md](ARCHITECTURE.md) and [ADRs](docs/adr) for design decisions, and [GLOSSARY.md](GLOSSARY.md) for domain terminology.

- Keep monetary arithmetic exact: bigint cents in the domain, decimal strings at API and persistence boundaries.
- Keep domain classes independent of NestJS and MikroORM.
- Inside `em.transactional`, execute SQL through `em.execute`; the connection API can bypass the transaction context.
- Run the MikroORM CLI with `bunx --bun mikro-orm`.
- Use real PostgreSQL and LocalStack for infrastructure tests. Serialize suites sharing the database with `flock ~/.cache/junglegame-db.lock` as documented in the README.
- Give database, queue, and child-process tests an explicit timeout. Keep child HTTP ports below 32768 to avoid the Linux ephemeral range.
- Verify financial scenarios against the balance reconstructed from the ledger. Wait for observable conditions with bounded polling.
