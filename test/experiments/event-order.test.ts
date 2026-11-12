import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { appOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { OutboxPublisher } from '../../src/infrastructure/sqs/outbox-publisher';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { initOrm } from '../support/db';
import { collectEvents, drainDueOutbox, realSqs } from '../support/events';
import { v7 as uuid } from 'uuid';
import { pinned } from '../support/pin';

/**
 * Per-Wallet event order on wager-events.fifo. The publisher claims rows FOR UPDATE SKIP LOCKED and sends them with
 * MessageGroupId = Wallet id; SQS FIFO keeps the order *of sends*, so the question is whether sends follow commit order.
 * ARCHITECTURE "Known deviations" says order is kept within one claimed batch only. Both ways it breaks are built here
 * deterministically (no timing luck): a stalled publisher overtaken by a second one, and a failed send that backs off.
 * Requirements do not demand event order (§8: broker ordering is an optimisation), so these are pinned
 * experiments (F10, test/support/pin.ts), not requirements. The passing test states what a consumer CAN rely on: walletVersion.
 */
setDefaultTimeout(180_000);
let app: Awaited<ReturnType<typeof startApp>>;
let owner: MikroORM;
const orms: MikroORM[] = [];
// Own events queue: drainDueOutbox pushes thousands of leftover rows into the shared one, which collectEvents would have to wade through.
const queueName = `t-${uuid().slice(0, 8)}-events.fifo`;
let queueUrl: string;
beforeAll(async () => { queueUrl = (await realSqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }))).QueueUrl!; process.env.OUTBOX_PUBLISHER = 'off'; app = await startApp(); owner = await initOrm(); });
afterAll(async () => { await realSqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => {}); await app.app.close(); await owner.close(); await Promise.all(orms.map((o) => o.close())); delete process.env.OUTBOX_PUBLISHER; });

const publisher = async (sqs: SQSClient, batchSize = 50) => {
  const orm = await MikroORM.init({ ...appOrmConfig, debug: false });
  orms.push(orm);
  return new OutboxPublisher(orm, sqs, { pollMs: 10, batchSize, backoffBaseMs: 1000, queueName });
};
/** An SQS client whose SendMessage calls go through `hook` first. */
const wrapped = (hook: () => Promise<void>) => ({ send: async (cmd: any) => { if (cmd instanceof SendMessageCommand) await hook(); return realSqs.send(cmd); } }) as unknown as SQSClient;

/** A Wallet with 4 events in commit order: OPENING (Processed, BalanceChanged), BET (Processed, BalanceChanged). */
async function walletWithFourEvents() {
  expect(await drainDueOutbox(owner)).toBe(0); // the publishers below must only find this Wallet's rows
  const w = await openWallet(app.base, '100.00');
  expect((await submit(app.base, bodyOf({ ...w, amount: '10.00' }))).status).toBe(201);
  const ids: string[] = (await owner.em.execute('select id from outbox_events where aggregate_id = ? order by seq', [w.walletId])).map((r: any) => r.id);
  expect(ids).toHaveLength(4);
  return { w, ids };
}

/** Publisher A claims the first 2 rows and stalls inside its first send; B claims the other 2 (SKIP LOCKED) and sends them. */
async function overtaken() {
  const { w, ids } = await walletWithFourEvents();
  let stalled!: () => void, go!: () => void;
  const isStalled = new Promise<void>((r) => (stalled = r)), gate = new Promise<void>((r) => (go = r));
  const a = await publisher(wrapped(async () => { stalled(); await gate; }), 2);
  const b = await publisher(realSqs);
  const aTick = a.tick();
  await isStalled; // A holds rows 1-2 locked, inside SendMessage for row 1
  expect(await b.tick()).toBe(2); // B skipped the locked rows and published rows 3-4
  go();
  expect(await aTick).toBe(2);
  const got = await collectEvents([w.walletId], (g) => g.length >= 4, 20_000, realSqs, queueName);
  expect(got).toHaveLength(4); // setup: all four arrived (an order check on fewer would fail for the wrong reason)
  return { w, ids, got };
}

pinned('F10: two publishers: a Wallet\'s events arrive in commit order (they do not when one publisher stalls mid-batch)', overtaken,
  ({ ids, got }) => expect(got.map((e) => e.eventId)).toEqual(ids));

pinned('F10: one publisher: a failed send does not let the Wallet\'s later events overtake it (it does: they go out while it backs off)', async () => {
  const { w, ids } = await walletWithFourEvents();
  let failed = false;
  const p = await publisher(wrapped(async () => { if (!failed) { failed = true; throw new Error('injected: SQS hiccup on the first send'); } }));
  await p.tick(); // row 1 fails and backs off 1 s; rows 2-4 are skipped in this batch to keep order...
  expect(await p.tick()).toBe(3); // ...but the next tick finds rows 2-4 due and row 1 not yet due
  const deadline = Date.now() + 5000; // row 1 is due again after its 1 s backoff
  while (Date.now() < deadline && (await p.tick()) === 0) await Bun.sleep(50);
  const got = await collectEvents([w.walletId], (g) => g.length >= 4, 20_000, realSqs, queueName);
  expect(got).toHaveLength(4);
  return { ids, got };
}, ({ ids, got }) => expect(got.map((e) => e.eventId)).toEqual(ids));

test('even when delivery is reordered, every event is delivered once and WalletBalanceChanged.walletVersion restores the true sequence', async () => {
  const { w, ids, got } = await overtaken();
  expect([...got.map((e) => e.eventId)].sort()).toEqual([...ids].sort()); // nothing lost, nothing doubled
  const changes = got.filter((e) => e.eventType === 'WalletBalanceChanged').sort((x, y) => x.data.walletVersion - y.data.walletVersion);
  expect(changes.map((e) => e.data.walletVersion)).toEqual([1, 2]); // contiguous: a consumer can detect a gap and wait
  for (let i = 1; i < changes.length; i++) expect(changes[i].data.balanceBefore).toEqual(changes[i - 1].data.balanceAfter);
  const { balance } = await (await fetch(`${app.base}/wallets/${w.walletId}`)).json();
  expect(changes.at(-1).data.balanceAfter).toEqual(balance);
});
