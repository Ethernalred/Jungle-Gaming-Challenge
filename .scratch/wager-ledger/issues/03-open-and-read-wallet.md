# 03: Open a Wallet and read it and its ledger

**What to build:** A caller can `POST /wallets` with a Player and initial Balance and get the Wallet back at version 1. A Balance above zero creates an internal OPENING Wager Transaction and its CREDIT Ledger Entry in the same DB transaction. The caller can then `GET /wallets/:walletId` and page through `GET /wallets/:walletId/ledger`. This ticket lays down the `wallets`, `wager_transactions` and `wallet_ledger_entries` tables with every constraint the spec says the DB must enforce. See spec D10, D12, D15 (DB checks), D17, D18, D20 (wallet rows), Requirements §6.2, §6.4, §9.

**Blocked by:** 01, 02

**Status:** done

- [ ] Domain classes `Wallet` (`open`, `rehydrate`, `credit`/`debit` that return the Ledger Entry) and `WalletLedgerEntry` (`create` checks the arithmetic; no mutable fields), each with a private constructor; the mappers between domain and EntitySchema are kept separate
- [ ] Reversible migration with: `balance >= 0`, unique `(player_id, currency)`, Wager Transaction kind/status checks, the OPENING checks from D10, the amount check from D6 (`amount > 0 OR kind = 'LOSS'`), both idempotency unique keys from D13, the one-reversal partial unique index from D8, a Ledger Entry arithmetic check, unique `(wallet_id, transaction_id)`, an immutability trigger, and an app role with no UPDATE/DELETE on Ledger Entries
- [ ] An integration test proves each constraint rejects bad data when written directly with SQL (bypassing the app)
- [ ] Duplicate Wallet → 409 `WALLET_ALREADY_EXISTS`; initial Balance `0.00` → no OPENING row, version 1
- [ ] Ledger cursor is opaque and stable when new entries are added between pages; `limit` defaults to 50, max 200
- [ ] Unknown Wallet → 404
- [ ] Final invariant asserted: Wallet Balance equals the sum of its ledger
