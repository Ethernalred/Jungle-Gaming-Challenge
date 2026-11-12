import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string; // decimal string with exactly 2 decimals, e.g. "25.00"
  currency: string; // ISO-4217
}

const AMOUNT = /^\d+\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

// Amounts are bigint cents (ADR-0001). Results of subtract/negate may be negative; input never is.
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== 'string' || !AMOUNT.test(amount)) throw new InvalidMoneyError(`Invalid amount: ${String(amount)}`);
    Money.assertCurrency(currency);
    return new Money(BigInt(amount.replace('.', '')), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) throw new InvalidMoneyError(`Invalid currency: ${String(currency)}`);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const abs = (this.cents < 0n ? -this.cents : this.cents).toString().padStart(3, '0');
    return `${this.cents < 0n ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
  }
}
