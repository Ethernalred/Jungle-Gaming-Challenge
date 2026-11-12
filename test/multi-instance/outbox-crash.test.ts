import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { appOrmConfig } from '../../src/infrastructure/persistence/orm.config';
import { OutboxPublisher } from '../../src/infrastructure/sqs/outbox-publisher';
import { openWallet } from '../support/app';
import { diedHard } from '../support/cluster';
import { collectEvents, drainDueOutbox, realSqs } from '../support/events';
import { initOrm } from '../support/db';
setDefaultTimeout(60_000);

let owner: MikroORM;
let child: ReturnType<typeof Bun.spawn> | undefined;
beforeAll(async () => { owner = await initOrm(); });
afterAll(async () => { child?.kill('SIGKILL'); await owner.close(); });

test('the process dies after commit and before publish: another publisher sends the event; a duplicate publish is harmless', async () => {
  // below the ephemeral range (32768+), else an outgoing connection may hold it and the child dies with EADDRINUSE
  // Earlier suites leave committed-but-unpublished rows; the fault child would claim them at startup and die before serving. Drain them first.
  expect(await drainDueOutbox(owner)).toBe(0);
  const port = 20000 + Math.floor(Math.random() * 10000);
  const base = `http://localhost:${port}`;
  // A real app process whose publisher SIGKILLs itself right after claiming rows (OUTBOX_FAULT hook), before any send.
  child = Bun.spawn(['bun', 'src/main.ts'], { env: { ...process.env, PORT: String(port), OUTBOX_FAULT: 'die-before-publish' }, stdout: 'ignore', stderr: 'ignore' });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !(await fetch(`${base}/health/live`).then((r) => r.ok, () => false))) await Bun.sleep(100);

  const { walletId } = await openWallet(base, '100.00'); // committed; the child dies when its publisher claims the rows
  await Promise.race([child.exited, Bun.sleep(20_000)]);
  expect(diedHard(child)).toBe(true);

  const pending = (await owner.em.execute('select id, published_at from outbox_events where aggregate_id = ?', [walletId]));
  expect(pending).toHaveLength(2); // committed and still unpublished
  expect(pending.every((r: any) => r.published_at === null)).toBe(true);
  const ids = pending.map((r: any) => r.id);

  const orm = await MikroORM.init({ ...appOrmConfig, debug: false });
  const other = new OutboxPublisher(orm, realSqs, { pollMs: 10 });
  other.start();
  try {
    const got = await collectEvents([walletId], (g) => g.length >= 2);
    expect(got.map((e) => e.eventId).sort()).toEqual([...ids].sort());

    // Duplicate publish: put the rows back to unpublished and publish again (a real at-least-once redelivery).
    await owner.em.execute('update outbox_events set published_at = null where aggregate_id = ?', [walletId]);
    const again = await collectEvents([walletId], () => false, 3000);
    const seen = new Set<string>(); // a consumer that dedupes by eventId applies each event once
    for (const e of [...got, ...again]) seen.add(e.eventId);
    expect([...seen].sort()).toEqual([...ids].sort());
  } finally {
    await other.stop();
    await orm.close();
  }
});
