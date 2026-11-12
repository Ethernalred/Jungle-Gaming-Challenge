import { DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { sqsClient } from '../../src/app.module';
import { appOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { OutboxPublisher } from '../../src/infrastructure/sqs/outbox-publisher';

export const realSqs = sqsClient();

/** Receives (and deletes) messages from wager-events.fifo until `done(events)` holds for those whose aggregateId is in `walletIds`, or times out. */
export async function collectEvents(walletIds: string[], done: (got: any[]) => boolean, timeoutMs = 20_000, sqs: SQSClient = realSqs, queueName = 'wager-events.fifo') {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  const got: any[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !done(got)) {
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    for (const m of r.Messages ?? []) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle! }));
      const e = JSON.parse(m.Body!);
      if (walletIds.includes(e.aggregateId)) got.push(e);
    }
  }
  return got;
}

export const eventTypes = (events: any[]) => events.map((e) => e.eventType);

/**
 * Publishes every due outbox row other suites left behind (they run with the publisher off and the DB is never wiped).
 * Call it before a test that drives a publisher and reasons about which rows it claims or when. Returns rows still due.
 */
export async function drainDueOutbox(owner: MikroORM, timeoutMs = 120_000) {
  const due = async () => (await owner.em.execute('select count(*)::int n from outbox_events where published_at is null and next_attempt_at <= now()'))[0].n as number;
  const orm = await MikroORM.init({ ...appOrmConfig, debug: false });
  const publisher = new OutboxPublisher(orm, realSqs, { pollMs: 10, batchSize: 500 });
  try {
    const deadline = Date.now() + timeoutMs;
    while ((await due()) > 0 && Date.now() < deadline) await publisher.tick();
    return await due();
  } finally { await orm.close(); }
}
