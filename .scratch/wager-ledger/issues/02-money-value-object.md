# 02: Money value object

**What to build:** An immutable `Money` that every money path uses: exact amounts held as bigint cents with a currency, parsed from and serialized to 2-decimal strings, and refusing to mix currencies. Pure domain code with no framework or ORM imports. See spec D4–D5, ADR-0001, Requirements §6.1.

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] `Money.from({ amount, currency })`, `Money.zero(currency)`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString`; private constructor; every operation returns a new instance
- [ ] Parsing accepts only `^\d+\.\d{2}$` plus a valid 3-letter currency; it rejects NaN, Infinity, exponent notation, empty strings, more than 2 decimals (for example `"1.005"`), and negatives
- [ ] Operations across currencies throw a domain error
- [ ] Very large values (up to the `NUMERIC(19,2)` range) round-trip exactly through string → Money → string
- [ ] No `number` is used for any amount anywhere
- [ ] Unit tests cover all of the above, including scale and the "no rounding, reject instead" rule
