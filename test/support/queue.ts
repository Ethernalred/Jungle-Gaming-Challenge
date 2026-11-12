import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuid } from 'uuid';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { SystemClock } from '../../src/domain/clock';
import { UuidV7Generator } from '../../src/domain/id-generator';
import { appOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { MikroWagerTransactionRepository } from '../../src/infrastructure/persistence/wager-transaction.repository';
import { ConsumerOptions, WagerConsumer } from '../../src/infrastructure/sqs/wager-consumer';
import { realSqs } from './events';

/**
 * Gives the calling suite its own FIFO queue + DLQ (maxReceiveCount = 5), so it never sees what other suites leave in the shared ones.
 * Sets QUEUE_NAME / DLQ_NAME: the consumers made here, the helpers below and child app processes (env inherited) all use them. Returns the cleanup.
 */
export async function isolateQueues() {
  const id = uuid().slice(0, 8), dlqName = `t-${id}-dlq.fifo`, queueName = `t-${id}.fifo`;
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const dlq = (await realSqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: fifo }))).QueueUrl!;
  const arn = (await realSqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn;
  const queue = (await realSqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { ...fifo, RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }) } }))).QueueUrl!;
  process.env.QUEUE_NAME = queueName; process.env.DLQ_NAME = dlqName;
  return async () => {
    delete process.env.QUEUE_NAME; delete process.env.DLQ_NAME;
    for (const QueueUrl of [queue, dlq]) await realSqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => {});
  };
}

export const queueUrl = async (name = process.env.QUEUE_NAME ?? 'wager-transactions.fifo') => (await realSqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;

export const requested = (data: Record<string, unknown>, messageId = `msg-${uuid()}`) => ({
  messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data,
});
export const dataOf = (w: { walletId: string; playerId: string }, o: Record<string, unknown> = {}) => {
  const ext = `ext-${uuid()}`;
  return { providerId: 'prov-q', externalTransactionId: ext, idempotencyKey: `prov-q:${ext}`, playerId: w.playerId, walletId: w.walletId,
    roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount: '10.00', currency: 'BRL' }, ...o };
};

/** Sends a raw body to the queue (FIFO: group = walletId; a fresh deduplication id each time, so the same body can be delivered twice). */
export async function send(body: unknown, group: string) {
  await realSqs.send(new SendMessageCommand({
    QueueUrl: await queueUrl(), MessageBody: typeof body === 'string' ? body : JSON.stringify(body), MessageGroupId: group, MessageDeduplicationId: uuid(),
  }));
}

/** Waits for a DLQ message whose body contains `needle`, deletes it, returns it. */
export async function takeFromDlq(needle: string, timeoutMs = 20_000) {
  const QueueUrl = await queueUrl(process.env.DLQ_NAME ?? 'wager-transactions-dlq.fifo');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await realSqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    for (const m of r.Messages ?? []) {
      await realSqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle! }));
      if (m.Body!.includes(needle)) return m.Body!;
    }
  }
  return null;
}

export async function until(cond: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await cond()) return true; await Bun.sleep(100); }
  return false;
}

/** A consumer wired like the app (restricted role, real use case), with short waits for tests. */
export async function makeConsumer(o: ConsumerOptions = {}, wrap?: (u: SubmitWagerTransaction) => Pick<SubmitWagerTransaction, 'execute'>) {
  const orm = await MikroORM.init({ ...appOrmConfig, debug: false });
  const useCase = new SubmitWagerTransaction(new MikroWagerTransactionRepository(orm), new SystemClock(), new UuidV7Generator());
  const consumer = new WagerConsumer(orm, realSqs, wrap ? wrap(useCase) : useCase, { waitSeconds: 1, ...o });
  return { orm, consumer, close: async () => { await consumer.stop(); await orm.close(); } };
}

export const rowCount = async (orm: MikroORM, sql: string, params: unknown[]) => Number((await orm.em.execute(sql, params))[0].n);
