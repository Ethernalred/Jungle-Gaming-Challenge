import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { expectBalanceMatchesLedger } from '../support/ledger';
import { openWallet, startApp } from '../support/app';
import { diedHard } from '../support/cluster';
import { realSqs } from '../support/events';
import { initOrm } from '../support/db';
import { dataOf, isolateQueues, makeConsumer, queueUrl, requested, rowCount, send, until } from '../support/queue';

setDefaultTimeout(90_000);
let dropQueues: () => Promise<void>;
let owner: MikroORM;
let app: Awaited<ReturnType<typeof startApp>>;
const children: ReturnType<typeof Bun.spawn>[] = [];
beforeAll(async () => { dropQueues = await isolateQueues(); owner = await initOrm(); app = await startApp(); });
afterAll(async () => { for (const c of children) c.kill('SIGKILL'); await app.app.close(); await owner.close(); await dropQueues(); });

const inboxHas = async (id: string) => (await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [id])) === 1;
const wagers = (walletId: string) => rowCount(owner, `select count(*) n from wager_transactions where wallet_id = ? and kind <> 'OPENING'`, [walletId]);
const balance = async (walletId: string) => (await owner.em.execute('select balance::text b from wallets where id = ?', [walletId]))[0].b;

/** A real app process (bun src/main.ts) running the consumer; QUEUE_FAULT is the fault hook. */
function spawnApp(fault: string) {
  // below the ephemeral range (32768+): a port in it can be taken by any outgoing connection (the child then dies with EADDRINUSE)
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), QUEUE_FAULT: fault, QUEUE_VISIBILITY_S: '3', QUEUE_WAIT_S: '1', OUTBOX_PUBLISHER: 'off' }, stdout: 'pipe', stderr: Bun.file(`${tmpdir()}/junglegame-child-${port}.err`),
  });
  children.push(child);
  return { child, port };
}
async function waitFor(child: ReturnType<typeof Bun.spawn>, line: string, timeoutMs = 30_000) {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)]);
    if (r?.value) buf += dec.decode(r.value);
    if (buf.includes(line)) { reader.releaseLock(); return true; }
    if (r?.done) break;
  }
  return false;
}
async function queueDepth() {
  const a = (await realSqs.send(new GetQueueAttributesCommand({ QueueUrl: await queueUrl(), AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }))).Attributes!;
  return Number(a.ApproximateNumberOfMessages) + Number(a.ApproximateNumberOfMessagesNotVisible);
}
async function ready(port: number) {
  return until(() => fetch(`http://localhost:${port}/health/live`).then((r) => r.ok, () => false), 30_000);
}

/** On a failed start or kill: what the child printed and what the queue and DB look like. */
async function diag(child: ReturnType<typeof Bun.spawn>, port: number, id: string, walletId: string, what: string) {
  const a = (await realSqs.send(new GetQueueAttributesCommand({ QueueUrl: await queueUrl(), AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }))).Attributes;
  child.kill('SIGKILL'); await child.exited;
  console.log('DIAG', what, 'port', port, 'exit', child.exitCode, child.signalCode, 'queue', JSON.stringify(a), 'inbox', await inboxHas(id), 'wagers', await wagers(walletId),
    'stderr', await Bun.file(`${tmpdir()}/junglegame-child-${port}.err`).text(), 'stdout', (await new Response(child.stdout as ReadableStream).text()).slice(-2000));
}

test('killed after commit and before ack: the redelivered message is a no-op and the state is consistent', async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = requested(dataOf(w));
  const { child, port } = spawnApp('die-after-commit');
  const up = await ready(port);
  if (!up) await diag(child, port, msg.messageId, w.walletId, 'NOT READY');
  expect(up).toBe(true);
  await send(msg, w.walletId);
  await Promise.race([child.exited, Bun.sleep(30_000)]);
  if (!diedHard(child)) await diag(child, port, msg.messageId, w.walletId, 'NOT KILLED');
  expect(diedHard(child)).toBe(true); // died by its own fault hook after the commit
  expect(await inboxHas(msg.messageId)).toBe(true);
  expect(await wagers(w.walletId)).toBe(1);
  expect(await balance(w.walletId)).toBe('90.00');

  const c = await makeConsumer({ visibilitySeconds: 3 }); // redelivery after the visibility timeout
  try {
    c.consumer.start();
    await Bun.sleep(7000); // visibility 3 s elapsed, the message was received again and acked as a duplicate
    expect(await wagers(w.walletId)).toBe(1);
    expect(await balance(w.walletId)).toBe('90.00');
    expect(await rowCount(owner, 'select count(*) n from inbox where message_id = ?', [msg.messageId])).toBe(1);
    await expectBalanceMatchesLedger(owner, w.walletId);
  } finally { await c.close(); }
  expect(await queueDepth()).toBe(0); // the message is really gone
});

const win = process.platform === 'win32';
test.skipIf(win)('SIGTERM during processing: the in-flight message finishes, is acked, nothing is half-applied' + (win ? ' (needs POSIX signals: skipped on Windows)' : ''), async () => {
  const w = await openWallet(app.base, '100.00');
  const msg = requested(dataOf(w));
  const { child, port } = spawnApp('slow');
  const up = await ready(port);
  if (!up) await diag(child, port, msg.messageId, w.walletId, 'NOT READY');
  expect(up).toBe(true);
  await send(msg, w.walletId);
  expect(await waitFor(child, 'CONSUMER_PROCESSING')).toBe(true); // inside the DB transaction now
  child.kill('SIGTERM');
  const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => 'timeout')]);
  expect(code).not.toBe('timeout'); // exited by itself within the 10 s grace
  expect(await inboxHas(msg.messageId)).toBe(true);
  expect(await wagers(w.walletId)).toBe(1);
  expect(await balance(w.walletId)).toBe('90.00');
  await expectBalanceMatchesLedger(owner, w.walletId);
  // acked, not left to be redelivered: a second look after the visibility timeout finds nothing new
  await Bun.sleep(4000);
  expect(await wagers(w.walletId)).toBe(1);  expect(await queueDepth()).toBe(0); // deleted, not given back
});
