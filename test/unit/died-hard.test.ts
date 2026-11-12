import { expect, test } from 'bun:test';
import { diedHard } from '../support/cluster';

const run = { exitCode: null, signalCode: null };
test('POSIX: only SIGKILL counts', () => {
  expect(diedHard({ exitCode: null, signalCode: 'SIGKILL' }, 'linux')).toBe(true);
  expect(diedHard({ exitCode: 1, signalCode: null }, 'linux')).toBe(false);
  expect(diedHard(run, 'linux')).toBe(false);
});
test('Windows: any exit counts, a running process does not', () => {
  expect(diedHard({ exitCode: 1, signalCode: null }, 'win32')).toBe(true);
  expect(diedHard({ exitCode: null, signalCode: 'SIGKILL' }, 'win32')).toBe(true);
  expect(diedHard(run, 'win32')).toBe(false);
});
