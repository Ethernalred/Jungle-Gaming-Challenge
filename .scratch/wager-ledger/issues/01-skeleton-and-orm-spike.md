# 01: Running skeleton with health checks and a proven ORM setup

**What to build:** `docker compose up` brings up PostgreSQL and LocalStack (with `wager-transactions.fifo`, `wager-transactions-dlq.fifo` wired by a redrive policy with `maxReceiveCount = 5`, and `wager-events.fifo`). The NestJS app runs on Bun and answers `GET /health/live` and `GET /health/ready` (which checks PostgreSQL and SQS). It also proves the risky stack combination before anything is built on it: MikroORM v7 under Bun can run one DB transaction that takes a `FOR UPDATE` lock, and a migration can go up and back down. See spec D1–D3, D28 (health part), ADR-0004.

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] Bun project, TypeScript strict, NestJS 11, MikroORM v7 + `@mikro-orm/postgresql`, set up as in D2 (EntitySchema only, explicit entity list, static `migrationsList`, decorator flags in the app's own tsconfig, `tinyglobby`)
- [ ] Docker Compose starts PostgreSQL and LocalStack; an init script creates the three queues and the redrive policy
- [ ] `bunx --bun mikro-orm migration:up` and `migration:down` both work; a throwaway spike migration proves it, then is removed
- [ ] An integration test, against the real database, runs `em.transactional()` with `LockMode.PESSIMISTIC_WRITE` and a raw `INSERT … ON CONFLICT DO NOTHING`
- [ ] `/health/live` returns 200; `/health/ready` returns 200 when both dependencies are up and 503 when PostgreSQL is stopped
- [ ] Injectable clock and UUIDv7 id generator exist
- [ ] `bun test` runs unit and integration suites separately (scripts documented in package.json)
