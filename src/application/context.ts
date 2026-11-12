import { AsyncLocalStorage } from 'node:async_hooks';

/** What every log line and event of one request / queue message shares (D28). */
export interface RequestContext { correlationId: string; messageId?: string }

const store = new AsyncLocalStorage<RequestContext>();
export const runWith = <T>(c: RequestContext, fn: () => T): T => store.run(c, fn);
export const currentContext = () => store.getStore();

/** correlationId / causationId for the events of one outcome: the request's (or message's); causationId = SQS messageId on the queue. */
export const traceFor = (fallbackCorrelationId: string) => ({
  correlationId: store.getStore()?.correlationId ?? fallbackCorrelationId,
  causationId: store.getStore()?.messageId,
});
