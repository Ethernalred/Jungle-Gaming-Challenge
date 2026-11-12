import { expect, test } from 'bun:test';
import { log, logTap } from '../../src/infrastructure/log';
import { runWith } from '../../src/application/context';

test('a log line carries the correlationId from the context and redacts amounts, balances and payloads', () => {
  const lines: string[] = [];
  logTap.fn = (l) => lines.push(l);
  log.level = 'info';
  runWith({ correlationId: 'corr-1', messageId: 'msg-1' }, () =>
    log.info({ transactionId: 't1', walletId: 'w1', providerId: 'p1', amount: '12.34', money: { amount: '12.34', currency: 'BRL' }, balance: { amount: '99.99' }, balanceAfter: '1.00', payload: { x: 1 }, body: { y: 2 } }, 'hello'));
  logTap.fn = undefined;
  const line = JSON.parse(lines[0]!);
  expect(line).toMatchObject({ correlationId: 'corr-1', messageId: 'msg-1', transactionId: 't1', walletId: 'w1', providerId: 'p1', msg: 'hello' });
  for (const k of ['amount', 'money', 'balance', 'balanceAfter', 'payload', 'body']) expect(line[k]).toBe('[Redacted]');
  expect(lines[0]).not.toMatch(/12\.34|99\.99/);
});
