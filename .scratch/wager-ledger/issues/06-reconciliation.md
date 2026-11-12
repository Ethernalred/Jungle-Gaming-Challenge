# 06: Wallet Reconciliation

**What to build:** `POST /wallets/:walletId/reconciliation` compares the stored Balance with the Balance rebuilt from the ledger and reports both, the difference, whether they match, and how many entries it checked. It reads a consistent snapshot even while bets are being placed. A Divergence is logged and reported, never fixed. See spec D19, Requirements §9 Reconciliation.

**Blocked by:** 03

**Status:** done

- [ ] One DB transaction with `FOR SHARE` on the Wallet; the calculated Balance is the signed sum of the Ledger Entries
- [ ] The response shape matches Requirements §9 exactly
- [ ] An integration test that forces a Divergence (by changing the Wallet Balance directly with SQL) gets `consistent: false` plus a warn log; no row is changed
- [ ] A test that runs Reconciliation while parallel BETs run never reports a false Divergence
- [ ] A Divergence counter is exposed so 10 can register it with `/metrics`
