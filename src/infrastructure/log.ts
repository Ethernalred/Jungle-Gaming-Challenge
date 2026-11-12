import pino from 'pino';
import { currentContext } from '../application/context';

/** Test hook: sees every line. */
export const logTap: { fn?: (line: string) => void } = {};

const sensitive = ['amount', 'money', 'balance', 'balanceBefore', 'balanceAfter', 'stored', 'calculated', 'difference', 'payload', 'body', 'data'];

/** D28: JSON logs, correlationId/messageId from the AsyncLocalStorage context; money and payloads are redacted, never logged. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  mixin: () => currentContext() ?? {},
  redact: { paths: [...sensitive, ...sensitive.map((k) => `*.${k}`)], censor: '[Redacted]' },
}, { write: (line: string) => { process.stdout.write(line); logTap.fn?.(line); } });
