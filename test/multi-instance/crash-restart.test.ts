import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Instance, diedHard, startCluster, startInstance, stopAll } from '../support/cluster';
import { initOrm } from '../support/db';
import { makeLoad } from '../support/load';
import { isolateQueues, until } from '../support/queue';

setDefaultTimeout(240_000);
let dropQueues: () => Promise<void>;
let owner: MikroORM;
let cluster: Instance[] = [];
beforeAll(async () => { dropQueues = await isolateQueues(); owner = await initOrm(); });
afterEach(async () => { await stopAll(cluster); cluster = []; }); // each test's survivors go too
afterAll(async () => { await stopAll(cluster); await owner.close(); await dropQueues(); });

test('kill -9 mid-flight: an instance dies after committing a queue message, another is killed under HTTP load; the survivors finish', async () => {
  // A is the only consumer and dies by its own hook right after the first commit, before ack (the message is redelivered after the 3 s visibility timeout)
  const a = await startInstance({ QUEUE_FAULT: 'die-after-commit' });
  cluster = [a];
  const load = await makeLoad(() => cluster.filter((i) => i.alive()), owner);
  await load.early();
  await Promise.race([a.proc.exited, Bun.sleep(30_000)]);
  expect(diedHard(a.proc)).toBe(true);

  cluster.push(...await startCluster(3));
  const [b] = cluster.slice(1);
  const running = load.main();
  const progressed = async () => Number((await owner.em.execute(`select count(*) n from wager_transactions where wallet_id = ? and kind <> 'OPENING'`, [load.hot.walletId]))[0].n) >= 20;
  expect(await until(progressed, 30_000)).toBe(true);
  await b.stop('SIGKILL'); // mid-flight: HTTP requests and queue messages are still arriving
  expect(diedHard(b.proc)).toBe(true);
  await running;
  await load.settle();
});

test('full restart: with the publisher and pending worker off there is a backlog; kill all instances, start new ones, the backlog drains and the state is consistent', async () => {
  const gen1 = await startCluster(3, { OUTBOX_PUBLISHER: 'off', PENDING_REFERENCE_WORKER: 'off' });
  cluster = gen1;
  const load = await makeLoad(() => cluster.filter((i) => i.alive()), owner);
  await load.early(); // Reversals before their BETs: PENDING_REFERENCE stays pending, the outbox stays unpublished
  const c = await load.counts();
  expect(c.pending).toBeGreaterThan(0);
  expect(c.unpublished).toBeGreaterThan(0);
  await stopAll(gen1.slice(0, 2), 'SIGKILL');
  await stopAll(gen1.slice(2), 'SIGTERM');

  cluster = await startCluster(3); // everything on
  await load.main();
  await load.settle();
});
