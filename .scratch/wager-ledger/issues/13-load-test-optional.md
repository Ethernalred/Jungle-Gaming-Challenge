# 13: Load test (optional extra)

**What to build:** `bun run test:load` runs a repeatable load experiment against 3 instances and writes a short, honest report. This is an optional extra after the core implementation and tests are complete (spec D29, Requirements §14 optional extras).

**Blocked by:** 11

**Status:** done

- [x] The run reports environment, method, throughput, p50/p95/p99, error rate, concurrency conflicts and outbox lag
- [x] It covers a hot-Wallet scenario and a spread-across-Wallets scenario
- [x] The analysis is added to ARCHITECTURE.md (or a linked file), including where the hot-Wallet ceiling shows
