# 11: Multi-instance, crash and restart proofs

**What to build:** Proof that the whole system stays correct with three or more real app processes sharing one database and queue, including a process being killed mid-flight and the service being restarted. See spec D30, Requirements §8, §13 concurrency tests 4, 5, 8.

**Blocked by:** 08, 09

**Status:** done

- [ ] The test harness starts at least 3 real `bun` app processes against the same PostgreSQL and LocalStack, and stops them all on exit
- [ ] Mixed load (HTTP and queue, the same hot Wallet plus many Wallets, duplicates and out-of-order Reversals) across the instances → no negative Balance, no double effect, Balance == ledger for every Wallet
- [ ] `kill -9` an instance mid-flight → the survivors finish the work (outbox, inbox, pending references); final state consistent
- [ ] Full restart of all instances → the final consistency check passes, and the outbox and pending queues drain
- [ ] Tests wait for conditions with timeouts, never fixed sleeps
