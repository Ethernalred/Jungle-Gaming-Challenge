import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuid } from 'uuid';
import { appOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { OutboxPublisher } from '../../src/infrastructure/sqs/outbox-publisher';
import { bodyOf, openWallet, startApp, submit } from '../support/app';
import { collectEvents, realSqs } from '../support/events';
import { initOrm } from '../support/db';

setDefaultTimeout(60_000);
let app: Awaited<ReturnType<typeof startApp>>;
let owner: MikroORM;
beforeAll(async () => { process.env.OUTBOX_PUBLISHER = 'off'; app = await startApp(); owner = await initOrm(); });
afterAll(async () => { await app.app.close(); await owner.close(); delete process.env.OUTBOX_PUBLISHER; });

test('two publishers on the same outbox: every event published exactly once, none lost', async () => {
  const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet(app.base, '100.00')));
  await Promise.all(wallets.flatMap((w) => [1, 2, 3].map(() => submit(app.base, bodyOf({ ...w, kind: 'BET', amount: '1.00' })))));
  const ids = wallets.map((w) => w.walletId);
  const expected: string[] = (await owner.em.execute('select id from outbox_events where aggregate_id = any(?::uuid[]) order by seq', [`{${ids.join(',')}}`])).map((r: any) => r.id);
  expect(expected).toHaveLength(8 * 2 + 8 * 3 * 2);

  const orms = [await MikroORM.init({ ...appOrmConfig, debug: false }), await MikroORM.init({ ...appOrmConfig, debug: false })]; // separate connections
  const pubs = orms.map((o) => new OutboxPublisher(o, realSqs, { pollMs: 10, batchSize: 5 }));
  pubs.forEach((p) => p.start());
  try {
    const got = await collectEvents(ids, (g) => g.length >= expected.length, 30_000);
    await Bun.sleep(300);
    got.push(...(await collectEvents(ids, () => false, 1500))); // anything extra would be a duplicate
    expect(got.map((e) => e.eventId).sort()).toEqual([...expected].sort());
    const [{ n }] = await owner.em.execute('select count(*)::int n from outbox_events where aggregate_id = any(?::uuid[]) and published_at is null', [`{${ids.join(',')}}`]);
    expect(n).toBe(0);
  } finally {
    await Promise.all(pubs.map((p) => p.stop()));
    await Promise.all(orms.map((o) => o.close()));
  }
});
