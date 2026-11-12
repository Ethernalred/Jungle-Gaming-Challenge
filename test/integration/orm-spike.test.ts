import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { EntitySchema, LockMode, MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../src/infrastructure/persistence/orm.config';
setDefaultTimeout(60_000);

class SpikeWallet { id!: string; balance!: string; }
const SpikeWalletSchema = new EntitySchema<SpikeWallet>({
  class: SpikeWallet,
  tableName: 'spike_wallet',
  properties: { id: { type: 'uuid', primary: true }, balance: { type: 'string', columnType: 'numeric(19,2)' } },
});

const sql: string[] = [];
let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init({
    ...ormConfig,
    entities: [SpikeWalletSchema],
    debug: true,
    logger: (m: string) => sql.push(m),
  });
  const c = orm.em.getConnection();
  await c.execute('drop table if exists spike_wallet');
  await c.execute('create table spike_wallet (id uuid primary key, balance numeric(19,2) not null)');
});
afterAll(async () => {
  await orm.em.getConnection().execute('drop table if exists spike_wallet');
  await orm.close();
});

test('em.transactional takes SELECT ... FOR UPDATE and a raw INSERT ON CONFLICT DO NOTHING works', async () => {
  const id = '0190a000-0000-7000-8000-000000000001';
  await orm.em.getConnection().execute(`insert into spike_wallet values ('${id}', '10.00')`);

  const inserted = await orm.em.transactional(async (em) => {
    const w = await em.findOneOrFail(SpikeWalletSchema, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    expect(w.balance).toBe('10.00');
    const first = await em.execute(
      'insert into spike_wallet (id, balance) values (?, ?) on conflict do nothing returning id', [id, '1.00']);
    const fresh = await em.execute(
      'insert into spike_wallet (id, balance) values (?, ?) on conflict do nothing returning id',
      ['0190a000-0000-7000-8000-000000000002', '2.00']);
    return { conflict: first.length, fresh: fresh.length };
  });

  expect(inserted).toEqual({ conflict: 0, fresh: 1 });
  expect(sql.some((s) => /for update/i.test(s))).toBe(true);
  expect(sql.some((s) => /begin/i.test(s)) && sql.some((s) => /commit/i.test(s))).toBe(true);
});
