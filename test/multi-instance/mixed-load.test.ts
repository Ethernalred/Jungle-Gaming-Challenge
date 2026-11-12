import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Instance, startCluster, stopAll } from '../support/cluster';
import { initOrm } from '../support/db';
import { makeLoad } from '../support/load';
import { isolateQueues } from '../support/queue';

setDefaultTimeout(180_000);
let dropQueues: () => Promise<void>;
let owner: MikroORM;
let cluster: Instance[] = [];
beforeAll(async () => { dropQueues = await isolateQueues(); owner = await initOrm(); });
afterAll(async () => { await stopAll(cluster); await owner.close(); await dropQueues(); });

test('3 instances, HTTP and queue load on a hot Wallet and many Wallets, duplicates and early Reversals: no negative Balance, no double effect, Balance == ledger', async () => {
  cluster = await startCluster(3);
  expect(new Set(cluster.map((i) => i.port)).size).toBe(3);
  const load = await makeLoad(() => cluster.filter((i) => i.alive()), owner);
  await Promise.all([load.early(), load.main()]);
  await load.settle();
});
