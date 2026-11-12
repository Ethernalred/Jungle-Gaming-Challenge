import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * A deterministic race: the test takes a Wallet's row lock on its own connection, the way a slow request would, lines
 * requests up behind it, proves through pg_stat_activity that they really are queued on that lock, then lets them all go.
 * Without this, `Promise.all` only *probably* overlaps requests; a pass might mean they ran one after another.
 * Mind lock_timeout (2 s in the app): release within it, or the queued requests turn into 503s.
 */
export async function holdWalletLock(owner: MikroORM, walletId: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: (pid: number) => void;
  const pid = new Promise<number>((r) => (locked = r));
  const done = owner.em.fork().transactional(async (em) => {
    const [row] = await em.execute('select pg_backend_pid() pid from wallets where id = ? for update', [walletId]);
    locked(Number(row.pid));
    await released;
  });
  const holder = await pid;

  /** Sessions blocked behind the holder, directly or through another waiter (PostgreSQL queues later waiters behind the first). */
  const waiters = async () => {
    const rows = await owner.em.fork().execute(`select pid, pg_blocking_pids(pid) blockers from pg_stat_activity where wait_event_type = 'Lock'`);
    const blocked = new Set<number>([holder]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of rows) {
        const p = Number(r.pid);
        if (!blocked.has(p) && (r.blockers as number[]).some((b) => blocked.has(Number(b)))) { blocked.add(p); grew = true; }
      }
    }
    return blocked.size - 1;
  };

  return {
    waiters,
    /** Bounded poll (10 ms steps) until at least `n` sessions wait on the lock. False on timeout: the race did not happen. */
    async queued(n: number, timeoutMs = 1500) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if ((await waiters()) >= n) return true; await Bun.sleep(10); }
      release(); // the race did not happen: do not leave the Wallet locked for the rest of the suite
      return false;
    },
    release: async () => { release(); await done; },
  };
}
