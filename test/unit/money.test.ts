import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, DomainError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money parsing', () => {
  test.each(['NaN', 'Infinity', '-Infinity', '1e3', '1.0e2', '', ' ', '1', '1.0', '1.005', '1.000', '-1.00', '+1.00', '.50', '1,00', ' 1.00', '1.00 ', '1.00\n'])(
    'rejects %p',
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );
  test.each(['brl', 'BR', 'BRLL', '', 'B1L'])('rejects currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
  test('rejects non-string amount', () => {
    expect(() => Money.from({ amount: 1.5 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });
  test('rejects instead of rounding', () => {
    expect(() => brl('0.999')).toThrow(DomainError);
  });
  test('accepts zero and leading zeros', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('007.50').toString()).toBe('7.50');
  });
});

describe('Money serialization and scale', () => {
  test('toJSON / toString keep 2 decimals', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('0.05').toString()).toBe('0.05');
    expect(brl('10.10').toString()).toBe('10.10');
    expect(JSON.stringify(brl('1.00'))).toBe('{"amount":"1.00","currency":"BRL"}');
  });
  test('NUMERIC(19,2) extremes round-trip exactly', () => {
    for (const a of ['99999999999999999.99', '90071992547409931.01', '0.01', '12345678901234567.89']) {
      expect(brl(a).toString()).toBe(a);
      expect(Money.from(brl(a).toJSON()).toString()).toBe(a);
    }
  });
  test('arithmetic is exact beyond Number precision', () => {
    expect(brl('90071992547409931.01').add(brl('0.01')).toString()).toBe('90071992547409931.02');
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });
  test('negative results serialize with a sign', () => {
    expect(brl('1.00').subtract(brl('1.05')).toString()).toBe('-0.05');
    expect(brl('1.00').subtract(brl('3.00')).toString()).toBe('-2.00');
  });
});

describe('Money operations', () => {
  test('zero', () => {
    expect(Money.zero('BRL').toString()).toBe('0.00');
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(() => Money.zero('xx')).toThrow(InvalidMoneyError);
  });
  test('add, subtract, negate return new instances', () => {
    const a = brl('5.00');
    const b = brl('2.50');
    const sum = a.add(b);
    const diff = a.subtract(b);
    const neg = a.negate();
    expect(sum.toString()).toBe('7.50');
    expect(diff.toString()).toBe('2.50');
    expect(neg.toString()).toBe('-5.00');
    expect(a.toString()).toBe('5.00');
    for (const r of [sum, diff, neg]) expect(r === a || r === b).toBe(false);
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
  });
  test('predicates', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
    expect(brl('1.00').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
    expect(brl('1.00').negate().isLessThan(brl('0.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
  });
  test('currency exposed and equals is currency-aware', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(usd.currency).toBe('USD');
    expect(usd.equals(brl('1.00'))).toBe(false);
  });
  test('mixed currencies throw a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    for (const op of [(m: Money) => m.add(usd), (m: Money) => m.subtract(usd), (m: Money) => m.isLessThan(usd)]) {
      expect(() => op(brl('1.00'))).toThrow(CurrencyMismatchError);
    }
    expect(() => brl('1.00').add(usd)).toThrow(DomainError);
  });
  test('constructor is private and instances are frozen', () => {
    const m = brl('1.00');
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });
});
