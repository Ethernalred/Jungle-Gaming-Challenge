/**
 * Runs the test suite chapter by chapter.
 *
 *   bun run playbook                 # every chapter except the long mutation one
 *   bun run playbook 6 8             # only chapters 6 and 8
 *   bun run playbook --step          # pause for Enter before each chapter (live demo)
 *   bun run playbook 12              # mutation testing (several minutes per mutant)
 *   bun run playbook 1 11 --json out.json   # also write per-chapter results with per-test names (used by test/dashboard.ts)
 * Needs the stack up (docker compose up -d --wait) and migrations applied. `bun run playbook` takes the shared DB lock (package.json flock); when running this file directly, wrap it in `flock ~/.cache/junglegame-db.lock`.
 */
import { tmpdir } from 'node:os';
type Chapter = { n: number; title: string; proves: string; files: string[]; note?: string; optIn?: boolean; command?: string[] };

const CHAPTERS: Chapter[] = [
  { n: 1, title: 'Money and domain rules', proves: 'exact decimal money (no floats), Wallet invariants, the Wager Transaction state machine, Reference rules', files: ['test/unit'] },
  { n: 2, title: 'Guarantees enforced by the schema', proves: 'uniqueness, immutability and non-negativity hold even for writes that bypass the app (Requirements §5.9)', files: ['test/integration/wallet-constraints.test.ts', 'test/integration/app-role.test.ts', 'test/integration/orm-spike.test.ts'] },
  { n: 3, title: 'HTTP contract', proves: 'every status code and Failure Code, Replays with the original Balance, the ledger and Reconciliation endpoints', files: ['test/integration/wallets-api.test.ts', 'test/integration/wagering-api.test.ts', 'test/integration/reversals.test.ts', 'test/integration/reconciliation.test.ts', 'test/integration/health.test.ts', 'test/integration/observability-metrics.test.ts'] },
  { n: 4, title: 'Races, proven to happen', proves: '§8 (2 x 80.00 on 100.00) and 30 copies of one BET (an older 50-copy test is not forced), with the competing requests proven queued on the same Wallet lock before they run', files: ['test/concurrency'] },
  { n: 5, title: 'Messaging: inbox, retries, DLQ, out-of-order References', proves: 'redelivery has one effect, transient errors retry, permanent ones go to the DLQ, a ROLLBACK before its BET waits and resolves', files: ['test/integration/queue-consumer.test.ts', 'test/integration/outbox.test.ts', 'test/integration/pending-reference-worker.test.ts'] },
  { n: 6, title: 'Atomicity at the exact moment of COMMIT', proves: 'a failure at COMMIT leaves nothing and publishes nothing; a connection killed at COMMIT is a 503 and a safe resend; no global lock', files: ['test/integration/commit-boundary.test.ts'] },
  { n: 7, title: 'Crashes and recovery with real processes', proves: 'kill -9 after commit before ack, SIGTERM mid-message, publisher death, 3 instances under load, full restart with a backlog', files: ['test/integration/queue-crash.test.ts', 'test/multi-instance'] },
  { n: 8, title: 'Model-based property testing', proves: 'random sequences of Provider requests get exactly the responses a small reference model predicts; failures shrink to a minimal example', files: ['test/property'] },
  { n: 9, title: 'Robustness: input validation and atomicity', proves: 'payloads that pass validation but hit a PostgreSQL limit are never half-applied; the wrong status codes are pinned', files: ['test/integration/robustness.test.ts'], note: 'tests named F1-F4 are pins (pinned()): green means "the bug is still there", red means fixed or setup broke' },
  { n: 10, title: 'Experiments: where the guarantees stop', proves: 'ledger listing order, per-Wallet event order, and a paused instance holding a lock: each limitation reproduced deterministically, next to what does still hold', files: ['test/experiments'], note: 'tests named F6/F9/F10 are pins (pinned()): green means "the limitation is still there", red means fixed or setup broke' },
  { n: 11, title: 'Testing the tests', proves: 'the invariant checker rejects the ledgers and rows real bugs leave behind (negative controls, unit and on a real database)', files: ['test/unit/ledger-walk.test.ts', 'test/integration/invariants-negative.test.ts'] },
  { n: 12, title: 'Mutation testing (opt-in, long)', proves: 'removing each correctness mechanism makes at least one test fail', files: [], optIn: true,
    command: ['bun', 'test/mutations/run.ts', ...(process.env.PLAYBOOK_MUTANTS ?? 'M1 M4 M8').split(' ')], note: 'runs the control plus PLAYBOOK_MUTANTS (default M1 M4 M8); full matrix: bun run test:mutants' },
];

const args = process.argv.slice(2);
const step = args.includes('--step');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const picked = args.filter((a) => /^\d+$/.test(a)).map(Number);
const chapters = CHAPTERS.filter((c) => (picked.length ? picked.includes(c.n) : !c.optIn));
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`, dim = (s: string) => `\x1b[2m${s}\x1b[0m`, green = (s: string) => `\x1b[32m${s}\x1b[0m`, red = (s: string) => `\x1b[31m${s}\x1b[0m`;

type Test = { name: string; status: 'pass' | 'fail'; pinned: boolean };
const results: { n: number; title: string; proves: string; note?: string; pass: number; fail: number; seconds: number; tests: Test[] }[] = [];
const decode = (x: string) => x.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[e.toLowerCase()] ?? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
// junit via `bun test --reporter=junit`: piped bun prints no (pass) lines, the XML has every testcase.
const parseJunit = (xml: string): Test[] => xml.split('<testcase ').slice(1).flatMap((chunk) => {
  const name = decode(chunk.match(/^name="([^"]*)"/)?.[1] ?? '');
  const body = chunk.split('</testcase>')[0];
  if (/<skipped/.test(body)) return [];
  return [{ name, status: /<(failure|error)/.test(body) ? 'fail' as const : 'pass' as const, pinned: /^F\d+/.test(name) }];
});
for (const c of chapters) {
  console.log(`\n${bold(`Chapter ${c.n}: ${c.title}`)}\n${dim(`Proves: ${c.proves}`)}${c.note ? `\n${dim(`Note: ${c.note}`)}` : ''}`);
  if (step) { process.stdout.write(dim('Press Enter to run… ')); for await (const _ of console) break; }
  const t0 = Date.now();
  const xml = `${tmpdir()}/playbook-${process.pid}-${c.n}.xml`;
  const cmd = c.command ?? ['bun', 'test', ...c.files, ...(jsonOut ? ['--reporter=junit', `--reporter-outfile=${xml}`] : [])];
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  let pass = 0, fail = 0, summaryPass = 0;
  const show = async (stream: ReadableStream<Uint8Array>) => {
    let buf = '';
    for await (const chunk of stream) {
      buf += new TextDecoder().decode(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/^\((pass|fail)\) (.*?)( \[[\d.]+m?s\])?$/);
        const t = line.match(/^ *(\d+) pass$/); if (t) summaryPass += Number(t[1]); // bun prints (pass) lines only on a TTY
        if (m) { m[1] === 'pass' ? pass++ : fail++; console.log(`  ${m[1] === 'pass' ? green('✓') : red('✗')} ${m[2]}`); }
        else if (c.command && /KILLED|survived|^M\d+ |^    - /.test(line)) console.log(`  ${line}`);
        else if (/^error:|^\s+(Expected|Received)/.test(line)) console.log(dim(`    ${line.trim()}`));
      }
    }
  };
  await Promise.all([show(p.stdout), show(p.stderr)]);
  const code = await p.exited;
  pass = Math.max(pass, summaryPass);
  if (code !== 0 && !fail) fail++; // a crashed bun prints no (fail) line
  let tests: Test[] = [];
  if (jsonOut && !c.command) { try { tests = parseJunit(await Bun.file(xml).text()); await Bun.file(xml).delete(); } catch {} }
  results.push({ n: c.n, title: c.title, proves: c.proves, note: c.note, tests, pass, fail, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(dim(`  ${pass} passed, ${fail} failed in ${Math.round((Date.now() - t0) / 1000)}s`));
}

if (jsonOut) await Bun.write(jsonOut, JSON.stringify(results, null, 1));
console.log(`\n${bold('Summary')}`);
for (const r of results) console.log(`  ${r.fail ? red('✗') : green('✓')} ${String(r.n).padStart(2)}  ${r.title.padEnd(58)} ${String(r.pass).padStart(3)} pass ${String(r.fail).padStart(2)} fail ${String(r.seconds).padStart(4)}s`);
process.exit(results.some((r) => r.fail) ? 1 : 0);
export {};
