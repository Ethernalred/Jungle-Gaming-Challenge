// Load experiment. Not a *.test.ts file, so `bun test` never picks it up. Run: bun run test:load
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { v7 as uuid } from 'uuid';
import { initOrm } from '../support/db';
import { bodyOf, openWallet, submit } from '../support/app';
import { startCluster, stopAll, type Instance } from '../support/cluster';

const MAX_IN_FLIGHT = 32; // machine safety: never more than this many requests at once
const HOT_N = 1000, SPREAD_N = 1000, SPREAD_WALLETS = 200, TIMEOUT_MS = 10_000;

const load1 = () => Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
async function calm() { // wait for 1-minute load <= 10 (poll 5 s, up to 2 min), else abort
  for (let i = 0; i <= 24; i++) { if (load1() <= 10) return; if (i < 24) await Bun.sleep(5000); }
  throw new Error(`aborting: 1-minute load stayed above 10 for 2 minutes (${load1()})`);
}
const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : NaN;
const cents = (s: string) => BigInt(s.replace('.', ''));
const sh = (cmd: string[]) => Bun.spawnSync(cmd).stdout.toString().trim();

const lockConflicts = async (inst: Instance[]) => {
  let sum = 0, lag = 0;
  for (const i of inst) {
    const t = await (await fetch(`${i.base}/metrics`)).text();
    sum += Number(/^lock_conflicts_total (\S+)/m.exec(t)?.[1] ?? 0);
    lag = Math.max(lag, Number(/^outbox_lag_seconds (\S+)/m.exec(t)?.[1] ?? 0));
  }
  return { sum, lag };
};

type Step = { scenario: string; conc: number; n: number; wallets: number; seconds: number; rps: number; p50: number; p95: number; p99: number;
  ok: number; rejected: number; errors: number; errorRate: number; conflicts: number; lagP50: number; lagMax: number; lagPeak: number; drainS: number };

async function main() {
  const orm = await initOrm();
  const db = orm.em.fork();
  const q = (sql: string, p: unknown[] = []) => db.execute(sql, p);
  const inst = await startCluster(3);
  const steps: Step[] = [];
  const problems: string[] = [];
  try {
    const env = {
      cpu: `${cpus().length} logical cores, ${cpus()[0].model}`, ram: `${(totalmem() / 2 ** 30).toFixed(1)} GiB`, os: sh(['uname', '-sr']),
      bun: Bun.version, pg: String((await q('select version()'))[0].version).split(' on ')[0],
      ls: String((await (await fetch('http://localhost:54566/_localstack/health')).json()).version ?? '?'),
      load: readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' '),
    };

    async function run(scenario: string, conc: number, n: number, nWallets: number) {
      await calm();
      const initial = n; // each BET is 1.00; funded so BETs are not expected to be rejected
      const ws = await Promise.all(Array.from({ length: nWallets }, () => openWallet(inst[0].base, `${Math.ceil(initial / nWallets) + 5}.00`)));
      const before = await lockConflicts(inst);
      const startedAt = Date.now();
      const lat: number[] = []; let ok = 0, rejected = 0, errors = 0, next = 0;
      const accepted = new Map<string, number>(); // walletId -> accepted BET count
      const t0 = performance.now();
      await Promise.all(Array.from({ length: Math.min(conc, MAX_IN_FLIGHT) }, async () => {
        for (let i; (i = next++) < n; ) {
          const w = ws[i % nWallets], base = inst[i % inst.length].base, s = performance.now();
          try {
            const r = await Promise.race([
              submit(base, bodyOf({ ...w, kind: 'BET', amount: '1.00' }), uuid()).then(async (x) => { await x.arrayBuffer(); return x; }),
              Bun.sleep(TIMEOUT_MS).then(() => { throw new Error('timeout'); }),
            ]);
            lat.push(performance.now() - s);
            if (r.status === 201 || r.status === 200) { ok++; accepted.set(w.walletId, (accepted.get(w.walletId) ?? 0) + 1); }
            else if (r.status === 422) rejected++; // expected business rejection (INSUFFICIENT_FUNDS)
            else errors++; // 5xx incl. 503 lock timeout
          } catch { errors++; lat.push(performance.now() - s); }
        }
      }));
      const seconds = (performance.now() - t0) / 1000;
      const after = await lockConflicts(inst);
      // outbox: wait until rows of this step are published, then commit->publish lag per row
      const d0 = performance.now();
      let left = 1;
      while (performance.now() - d0 < 60_000) {
        left = Number((await q(`select count(*)::int as c from outbox_events where published_at is null and created_at >= to_timestamp(?)`, [startedAt / 1000]))[0].c);
        if (!left) break; await Bun.sleep(250);
      }
      const drainS = (performance.now() - d0) / 1000;
      if (left) problems.push(`${scenario} c=${conc}: ${left} outbox rows still unpublished after 60 s`);
      const [l] = await q(`select coalesce(percentile_cont(0.5) within group (order by extract(epoch from published_at - created_at)),0)::float8 as p50,
        coalesce(max(extract(epoch from published_at - created_at)),0)::float8 as mx from outbox_events where published_at is not null and created_at >= to_timestamp(?)`, [startedAt / 1000]);
      // correctness: Reconciliation consistent AND Balance == initial - accepted BETs, for every Wallet touched
      const each = Math.ceil(initial / nWallets) + 5;
      const bad: string[] = [];
      let k = 0;
      await Promise.all(Array.from({ length: 8 }, async () => {
        for (let i; (i = k++) < ws.length; ) {
          const id = ws[i].walletId;
          const rec = await (await fetch(`${inst[0].base}/wallets/${id}/reconciliation`, { method: 'POST' })).json();
          const want = BigInt(each) * 100n - BigInt(accepted.get(id) ?? 0) * 100n;
          if (!rec.consistent || cents(rec.storedBalance.amount) !== want) bad.push(`${id} ${JSON.stringify(rec)} want ${want}`);
        }
      }));
      if (bad.length) problems.push(`${scenario} c=${conc}: ${bad.length} Wallets failed correctness, e.g. ${bad[0]}`);
      lat.sort((a, b) => a - b);
      const total = ok + rejected + errors;
      const s: Step = { scenario, conc, n, wallets: nWallets, seconds, rps: total / seconds, p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99),
        ok, rejected, errors, errorRate: errors / total, conflicts: after.sum - before.sum, lagP50: l.p50, lagMax: l.mx, lagPeak: after.lag, drainS };
      steps.push(s);
      console.error(`${scenario} c=${conc}: ${s.rps.toFixed(0)} req/s p99 ${s.p99.toFixed(0)} ms err ${errors}`);
    }

    for (const c of [1, 4, 16, 32]) await run('hot Wallet', c, HOT_N, 1);
    for (const c of [16, 32]) await run('spread', c, SPREAD_N, SPREAD_WALLETS);

    const f = (x: number, d = 1) => x.toFixed(d);
    const md = `# Load test

Generated by \`bun run test:load\` (test/load/run.ts) on ${new Date().toISOString()}. Numbers are from this run only; see ARCHITECTURE.md "Load test" for the analysis.

## Environment
- CPU: ${env.cpu}; RAM ${env.ram}; ${env.os}
- Bun ${env.bun}; ${env.pg}; LocalStack ${env.ls} (SQS only)
- Load average (1/5/15 min) when the run started: ${env.load}
- The load client, the 3 app instances (separate Bun processes), PostgreSQL and LocalStack all run on this ONE machine (containers under Podman). They compete for the same cores, so the numbers are a lower bound for this design and not a capacity claim.

## Method
- 3 app instances (\`bun src/main.ts\`) on one PostgreSQL; each request goes round-robin to the next instance. Each step sends ${HOT_N} BET Wager Transactions of 1.00 BRL (unique Idempotency Key each) with a fixed number of requests in flight (client concurrency, capped at ${MAX_IN_FLIGHT}).
- Hot Wallet: all requests on one Wallet, at client concurrency 1, 4, 16, 32. Spread: ${SPREAD_N} requests over ${SPREAD_WALLETS} Wallets, concurrency 16 and 32. Wallets are funded so BETs are not expected to be rejected.
- Latency is client-side wall time per request (fetch, includes the response body), p50/p95/p99 by nearest rank. Throughput = completed requests / step wall time.
- Error rate counts 5xx (including 503 lock timeouts) and network errors/timeouts; expected business rejections (422 INSUFFICIENT_FUNDS) are counted separately. Retries are not performed.
- Conflicts = delta of \`lock_conflicts_total\` summed over the 3 instances' /metrics.
- Outbox lag = \`published_at - created_at\` of the Outbox rows created during the step (p50/max), measured after waiting for the step's rows to be published; "peak" is \`outbox_lag_seconds\` (age of the oldest unpublished row) scraped right after the step's last request. Drain = time until all of the step's rows were published.
- After every step, every touched Wallet is checked: Reconciliation \`consistent: true\` and Balance == initial funds minus accepted BETs. The run exits non-zero otherwise.

## Results
| Scenario | Conc. | Wallets | Req | req/s | p50 ms | p95 ms | p99 ms | ok | rejected (422) | errors | error rate | lock conflicts | outbox lag p50 / max s | peak s | drain s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${steps.map((s) => `| ${s.scenario} | ${s.conc} | ${s.wallets} | ${s.n} | ${f(s.rps)} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.p99)} | ${s.ok} | ${s.rejected} | ${s.errors} | ${f(s.errorRate * 100, 2)}% | ${s.conflicts} | ${f(s.lagP50, 2)} / ${f(s.lagMax, 2)} | ${f(s.lagPeak, 2)} | ${f(s.drainS, 1)} |`).join('\n')}

## Correctness
${problems.length ? problems.map((p) => `- FAILED: ${p}`).join('\n') : '- Every touched Wallet: Reconciliation consistent:true and Balance == initial funds minus accepted BETs; all Outbox rows published.'}
`;
    console.log(md);
    writeFileSync('docs/load-test.md', md);
  } finally {
    await stopAll(inst);
    await orm.close();
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
