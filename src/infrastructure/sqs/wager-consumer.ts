import { MikroORM } from '@mikro-orm/postgresql';
import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueUrlCommand, Message, ReceiveMessageCommand, SQSClient, SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { DomainError, InvalidMoneyError, InvalidTransactionStateError, TransientError, ValidationError } from '../../domain/errors';
import { payloadHash } from '../../domain/wager-transaction';
import { v7 as uuid } from 'uuid';
import { runWith } from '../../application/context';
import { log } from '../log';
import { dlqMessages, duplicates, retries } from '../metrics/metrics';
import { InboxDuplicate, InboxHashMismatch, InboxRepository } from '../persistence/inbox.repository';

export interface ConsumerOptions {
  consumerName?: string;
  queueName?: string;
  dlqName?: string;
  waitSeconds?: number; // D25: 20
  batchSize?: number; // D25: 10
  visibilitySeconds?: number; // D25: 30
  backoffBaseSeconds?: number; // transient retry delay = base * 2^(receives-1), capped at visibility
  graceMs?: number; // D26: 10000
}

type Outcome = 'ack' | 'dlq' | 'retry';

/** Thrown for a message that can never succeed (unparseable, invalid, OPENING on the queue). */
class PermanentError extends Error {}

/**
 * D25/D26: long-polls wager-transactions.fifo and runs the same SubmitWagerTransaction as HTTP. The inbox row commits in the Wager
 * Transaction's DB transaction; the message is deleted only afterwards. Test hook QUEUE_FAULT: 'slow' | 'die-after-commit'.
 * ponytail: a batch is processed one message at a time (keeps FIFO order inside a group); parallel groups if throughput needs it.
 */
export class WagerConsumer {
  private readonly o: Required<ConsumerOptions>;
  private readonly inbox: InboxRepository;
  private stopped = true;
  private abort = new AbortController();
  private loop: Promise<void> = Promise.resolve();
  private inFlight: Promise<Outcome> | undefined;
  private current: Message | undefined;
  private urls?: { queue: string; dlq: string };

  constructor(private readonly orm: MikroORM, private readonly sqs: SQSClient, private readonly submit: Pick<SubmitWagerTransaction, 'execute'>, o: ConsumerOptions = {}) {
    this.o = {
      consumerName: 'wager-transactions', queueName: process.env.QUEUE_NAME ?? 'wager-transactions.fifo', dlqName: process.env.DLQ_NAME ?? 'wager-transactions-dlq.fifo', // env: tests give each suite its own queues
      waitSeconds: Number(process.env.QUEUE_WAIT_S ?? 20), batchSize: 10, visibilitySeconds: Number(process.env.QUEUE_VISIBILITY_S ?? 30),
      backoffBaseSeconds: 1, graceMs: 10_000, ...o,
    };
    this.inbox = new InboxRepository(orm);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  /**
   * D26: stop polling, wait up to graceMs for the message being processed, then give it back (visibility 0).
   * An open long poll is let finish (aborting it can strand a message server-side until its visibility expires); it is only aborted after graceMs.
   */
  async stop() {
    this.stopped = true;
    const deadline = Date.now() + this.o.graceMs;
    const within = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), Math.max(0, deadline - Date.now())))]);
    if (this.inFlight && !(await within(this.inFlight)) && this.current) await this.giveBack(this.current);
    if (!(await within(this.loop))) this.abort.abort(); // the loop may still be stuck on a message that never finishes; the process is going away
  }

  private async run() {
    while (!this.stopped) {
      try {
        this.urls ??= await this.resolveUrls();
        const r = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: this.urls.queue, MaxNumberOfMessages: this.o.batchSize, WaitTimeSeconds: this.o.waitSeconds,
          VisibilityTimeout: this.o.visibilitySeconds, MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }), { abortSignal: this.abort.signal });
        if (process.env.QUEUE_DEBUG) console.error('received', r.Messages?.length);
        for (const m of r.Messages ?? []) {
          if (this.stopped) { await this.giveBack(m); continue; } // not started: visible again at once
          this.current = m;
          this.inFlight = this.handle(m);
          await this.inFlight;
          this.inFlight = this.current = undefined;
        }
      } catch (e) {
        if (process.env.QUEUE_DEBUG) console.error('consumer loop', e);
        if (!this.stopped) await new Promise((res) => setTimeout(res, 500)); // queue unreachable: poll again shortly
      }
    }
  }

  private async resolveUrls() {
    const url = async (QueueName: string) => (await this.sqs.send(new GetQueueUrlCommand({ QueueName }))).QueueUrl!;
    return { queue: await url(this.o.queueName), dlq: await url(this.o.dlqName) };
  }

  private async giveBack(m: Message) {
    await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.urls!.queue, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: 0 })).catch(() => {});
  }

  /** Classifies the message (D25) and acts: business -> ack, permanent -> DLQ then delete, transient -> back off. */
  private async handle(m: Message): Promise<Outcome> {
    const { queue, dlq } = this.urls!;
    let outcome: Outcome;
    const messageId = m.MessageId ?? '';
    let correlationId = uuid();
    try { const c = JSON.parse(m.Body ?? '').correlationId; if (typeof c === 'string' && /^[\w.:-]{1,128}$/.test(c)) correlationId = c; } catch { /* process() rejects it */ }
    try {
      await runWith({ correlationId, messageId: this.messageIdOf(m) ?? messageId }, () => this.process(m));
      outcome = 'ack';
    } catch (e) {
      outcome = classify(e);
      if (process.env.QUEUE_DEBUG) console.error('classified', outcome, e);
      if (e instanceof InboxDuplicate) duplicates.inc({ source: 'inbox' });
      if (outcome === 'retry') retries.inc({ source: 'queue' });
      if (outcome === 'dlq') dlqMessages.inc();
      if (outcome !== 'ack') log.warn({ correlationId, messageId: this.messageIdOf(m) ?? messageId, outcome, err: (e as Error).message }, 'queue message not processed');
    }
    try {
      if (outcome === 'retry') {
        const n = Number(m.Attributes?.ApproximateReceiveCount ?? 1);
        const wait = Math.min(this.o.visibilitySeconds, this.o.backoffBaseSeconds * 2 ** (n - 1));
        await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queue, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: wait }));
        return outcome;
      }
      if (outcome === 'dlq') {
        const group = m.Attributes?.MessageGroupId;
        await this.sqs.send(new SendMessageCommand({ QueueUrl: dlq, MessageBody: m.Body!, MessageGroupId: group ?? 'dlq', MessageDeduplicationId: m.MessageId }));
      }
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: m.ReceiptHandle! })); // only after commit
    } catch { /* the message stays in flight and is redelivered; the inbox makes that a no-op */ }
    return outcome;
  }

  /** The messageId inside the body (the Provider-side id the inbox dedupes on); the SQS MessageId differs per delivery. */
  private messageIdOf(m: Message): string | undefined {
    try { const id = JSON.parse(m.Body ?? '').messageId; return typeof id === 'string' ? id : undefined; } catch { return undefined; }
  }

  private async process(m: Message) {
    let msg: any;
    try { msg = JSON.parse(m.Body ?? ''); } catch { throw new PermanentError('unparseable'); }
    const d = msg?.data;
    if (msg?.type !== 'WagerTransactionRequested' || typeof msg.messageId !== 'string' || !msg.messageId || !d || typeof d !== 'object') throw new PermanentError('invalid message');
    if (d.kind === 'OPENING') throw new PermanentError('OPENING is internal'); // never accepted from a Provider
    const hash = payloadHash(d);
    const fault = process.env.QUEUE_FAULT;
    await this.submit.execute(d, async () => {
      await this.inbox.record(this.o.consumerName, msg.messageId, hash);
      if (fault === 'slow') { console.log('CONSUMER_PROCESSING'); await new Promise((res) => setTimeout(res, 1500)); } // test hook: SIGTERM lands mid DB transaction
    });
    if (fault === 'die-after-commit') process.kill(process.pid, 'SIGKILL'); // test hook: committed, not yet acked
  }

  onModuleDestroy() { return this.stop(); }
}

function classify(e: unknown): Outcome {
  if (e instanceof InboxDuplicate) return 'ack'; // committed by an earlier delivery
  if (e instanceof PermanentError || e instanceof InboxHashMismatch || e instanceof ValidationError || e instanceof InvalidMoneyError || e instanceof InvalidTransactionStateError) return 'dlq';
  if (e instanceof DomainError && !(e instanceof TransientError)) return 'ack'; // business: stored outcome or terminal rule, resending cannot help
  return 'retry'; // TransientError or anything unexpected; maxReceiveCount = 5 sends a repeating one to the DLQ
}
