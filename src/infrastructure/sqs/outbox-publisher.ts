import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { backoffMs } from '../../domain/outbox';
import { log } from '../log';
import { retries } from '../metrics/metrics';

export interface PublisherOptions {
  pollMs?: number; // D24: 500
  batchSize?: number; // D24: 50
  backoffBaseMs?: number; // D24: 1000
  backoffCapMs?: number; // D24: 300000
  queueName?: string;
}

/**
 * D24: claims due outbox rows FOR UPDATE SKIP LOCKED, sends each to the FIFO queue (group = aggregateId, dedup id = eventId),
 * marks it published; a failed send backs the row off and is retried forever.
 * ponytail: the claim (DB transaction) stays open during the send calls; a dead publisher releases it. Ordering is kept within a claimed batch only; at-least-once, consumers dedupe by eventId.
 */
export class OutboxPublisher {
  private timer?: NodeJS.Timeout;
  private running: Promise<unknown> = Promise.resolve();
  private stopped = true;
  private queueUrl?: string;
  private readonly o: Required<PublisherOptions>;

  constructor(private readonly orm: MikroORM, private readonly sqs: SQSClient, o: PublisherOptions = {}) {
    this.o = { pollMs: 500, batchSize: 50, backoffBaseMs: 1000, backoffCapMs: 300_000, queueName: 'wager-events.fifo', ...o };
  }

  onModuleInit() { if (process.env.OUTBOX_PUBLISHER !== 'off') this.start(); } // off: tests run the publisher on their own
  onModuleDestroy() { return this.stop(); }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = () => {
      this.running = this.tick().catch(() => {}).finally(() => { if (!this.stopped) this.timer = setTimeout(loop, this.o.pollMs); });
    };
    loop();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One claim-send-mark pass. Returns how many rows were published. */
  async tick(): Promise<number> {
    return this.orm.em.fork().transactional(async (em) => {
      const rows = await em.execute(
        `select seq, id, aggregate_id, payload::text as body, attempts from outbox_events
         where published_at is null and next_attempt_at <= now() order by seq limit ? for update skip locked`, [this.o.batchSize]);
      if (rows.length && process.env.OUTBOX_FAULT === 'die-before-publish') process.kill(process.pid, 'SIGKILL'); // test hook: crash after claim, before send
      let sent = 0;
      const blocked = new Set<string>(); // aggregates with a failed send in this batch: their later events wait, keeping order
      for (const r of rows) {
        if (blocked.has(r.aggregate_id)) continue;
        try {
          await this.send(r);
          await em.execute('update outbox_events set published_at = now() where seq = ?', [r.seq]);
          sent++;
          const e = JSON.parse(r.body);
          log.info({ correlationId: e.correlationId, causationId: e.causationId, eventId: r.id, eventType: e.eventType, walletId: r.aggregate_id, transactionId: e.data?.transactionId }, 'event published');
        } catch (err) {
          retries.inc({ source: 'outbox' });
          log.warn({ eventId: r.id, walletId: r.aggregate_id, attempts: Number(r.attempts) + 1, err: (err as Error).message }, 'event publish failed, backing off');
          const wait = backoffMs(Number(r.attempts), this.o.backoffBaseMs, this.o.backoffCapMs);
          await em.execute(`update outbox_events set attempts = attempts + 1, next_attempt_at = now() + ? * interval '1 millisecond' where seq = ?`, [wait, r.seq]);
          blocked.add(r.aggregate_id);
        }
      }
      return sent;
    });
  }

  private async send(r: Record<string, any>) {
    this.queueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.o.queueName }))).QueueUrl!;
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: r.body, MessageGroupId: r.aggregate_id, MessageDeduplicationId: r.id }));
  }
}
