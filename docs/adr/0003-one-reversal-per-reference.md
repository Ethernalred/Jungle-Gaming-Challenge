# A Wager Transaction can be reversed once, by either Kind

The spec forbids reversing a Reference twice "by the same Kind", which literally allows a BET to be both REFUNDed and ROLLed BACK, crediting the stake twice and breaking the no-duplicate-credit invariant. We read it strictly: a referenced Wager Transaction has at most one Processed Reversal of any Kind, enforced by a partial unique index on the reference. Reversing a Reversal (a ROLLBACK of a REFUND) is still allowed, because it references the REFUND, not the BET.
