/**
 * Mutation checks for distributed-systems correctness mechanisms.
 * Each mutant removes or breaks ONE correctness mechanism. For each, the runner copies the working tree (tracked and
 * untracked files, not node_modules) into a disposable directory, applies one exact text edit, migrates a fresh database
 * `jungle_mut`, runs the suite there and records which tests fail. The working tree and the `jungle` database are never
 * touched. M0 applies nothing: it is the control (a failure there is flakiness, not a kill).
 *
 *   flock ~/.cache/junglegame-db.lock bun test/mutations/run.ts            # all mutants
 *   flock ~/.cache/junglegame-db.lock bun test/mutations/run.ts M1 M8      # some
 *   MUTATION_TESTS="test/concurrency test/unit" bun test/mutations/run.ts  # a narrower suite (default: all but load)
 * Writes reports/testing/mutation-results.md (and .json next to it).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type Edit = { file: string; find: string; replace: string };
type Mutant = { id: string; title: string; mechanism: string; edits: Edit[]; predicted: string[] };

const REPO = join(import.meta.dir, '../..');
const ON = (find: string, replace: string, file: string): Edit => ({ file, find, replace });
const REPOSITORY = 'src/infrastructure/persistence/wager-transaction.repository.ts';
const MIGRATION = 'src/infrastructure/persistence/migrations/Migration20260101000003_wallet_ledger.ts';
const CONSUMER = 'src/infrastructure/sqs/wager-consumer.ts';

export const MUTANTS: Mutant[] = [
  { id: 'M0', title: 'control: no change', mechanism: 'none', edits: [], predicted: [] },
  { id: 'M1', title: 'remove the Wallet row lock (SELECT … FOR UPDATE)', mechanism: 'pessimistic lock per Wallet',
    edits: [ON('{ id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE })', '{ id: walletId })', REPOSITORY)],
    predicted: ['concurrency/*', 'wagering-api lock_timeout 503', 'forced-interleavings'] },
  { id: 'M2', title: 'drop the idempotency unique constraints', mechanism: 'persistent idempotency in the schema',
    edits: [ON(`        constraint wager_transactions_idempotency_unique unique (provider_id, idempotency_key),
        constraint wager_transactions_external_id_unique unique (provider_id, external_transaction_id)`,
      '        constraint wager_transactions_mutant_no_unique check (true)', MIGRATION)],
    predicted: ['50 parallel copies', 'Replay tests', 'queue: same key other messageId', 'property model'] },
  { id: 'M3', title: 'parse money through a float (Number(amount) * 100, truncated)', mechanism: 'exact decimal money',
    edits: [ON("new Money(BigInt(amount.replace('.', '')), currency)", 'new Money(BigInt(Math.trunc(Number(amount) * 100)), currency)', 'src/domain/money.ts')],
    predicted: ['unit/money extremes and precision'] },
  { id: 'M4', title: 'publish events to SQS inside the DB transaction (before commit), as well as via the outbox', mechanism: 'transactional outbox: nothing published before commit',
    edits: [ON(`export async function writeOutbox(em: EntityManager, events: IntegrationEvent<any>[]): Promise<void> {
  if (!events.length) return;`, `export async function writeOutbox(em: EntityManager, events: IntegrationEvent<any>[]): Promise<void> {
  if (!events.length) return;
  const { sqsClient } = await import('../../app.module');
  const { GetQueueUrlCommand, SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const sqs = sqsClient();
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-events.fifo' }));
  for (const e of events) await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(e), MessageGroupId: e.aggregateId, MessageDeduplicationId: 'early-' + e.eventId }));`, 'src/infrastructure/persistence/outbox.ts')],
    predicted: ['commit-boundary: no event for a rolled-back transaction'] },
  { id: 'M5', title: 'ack (delete) the SQS message before processing it', mechanism: 'ack only after commit',
    edits: [ON(`    try {
      await runWith({ correlationId, messageId: this.messageIdOf(m) ?? messageId }, () => this.process(m));`, `    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: m.ReceiptHandle! }));
    try {
      await runWith({ correlationId, messageId: this.messageIdOf(m) ?? messageId }, () => this.process(m));`, CONSUMER)],
    predicted: ['queue-consumer transient retry', 'commit-boundary queue', 'queue → DLQ tests'] },
  { id: 'M6', title: 'drop the ledger (wallet, transaction) unique and the one-Reversal partial unique index', mechanism: 'schema uniqueness as a second line of defence',
    edits: [ON(`),
        constraint ledger_wallet_transaction_unique unique (wallet_id, transaction_id)`, ')', MIGRATION),
      ON('create unique index wager_transactions_one_reversal', 'create index wager_transactions_one_reversal', MIGRATION)],
    predicted: ['wallet-constraints only (the app never relies on them while the lock holds)'] },
  { id: 'M7', title: 'disable the inbox (record nothing, never detect a redelivery)', mechanism: 'persistent inbox dedup',
    edits: [ON(`  async record(consumerName: string, messageId: string, hash: string): Promise<void> {
`, `  async record(consumerName: string, messageId: string, hash: string): Promise<void> {
    if (consumerName) return;
`, 'src/infrastructure/persistence/inbox.repository.ts')],
    predicted: ['queue-consumer inbox and hash-mismatch tests'] },
  { id: 'M8', title: 'remove the "already reversed" check', mechanism: 'a Reference is reversed at most once',
    edits: [ON("  if (reversal && (await locked.hasProcessedReversal(ref.id))) return reject('ALREADY_REVERSED');\n", '', 'src/application/resolve-reference.ts')],
    predicted: ['reversals', 'reversal-race', 'property model'] },
  { id: 'M9', title: 'publish the outbox newest-first', mechanism: 'per-Wallet event order (not a spec guarantee)',
    edits: [ON('where published_at is null and next_attempt_at <= now() order by seq limit ?', 'where published_at is null and next_attempt_at <= now() order by seq desc limit ?', 'src/infrastructure/sqs/outbox-publisher.ts')],
    predicted: ['nothing required; experiments/event-order documents order as not guaranteed'] },
  { id: 'M10', title: 'ack every failed message (treat transient errors as done)', mechanism: 'transient errors are retried',
    edits: [ON("  return 'retry'; // TransientError or anything unexpected", "  return 'ack'; // TransientError or anything unexpected", CONSUMER)],
    predicted: ['queue-consumer transient tests', 'commit-boundary queue', 'robustness queue poison → DLQ'] },
  { id: 'M11', title: 'drop CHECK (balance >= 0)', mechanism: 'non-negative Balance in the schema',
    edits: [ON('        constraint wallets_balance_non_negative check (balance >= 0),\n', '', MIGRATION)],
    predicted: ['wallet-constraints only'] },
  { id: 'M12', title: 'add a global lock (one advisory lock for every Wallet)', mechanism: 'no lock shared by all Wallets (§5.6)',
    edits: [ON("        await em.execute(`set local lock_timeout = '2s'`);", "        await em.execute(`set local lock_timeout = '2s'`);\n        await em.execute('select pg_advisory_xact_lock(42)');", REPOSITORY)],
    predicted: ['commit-boundary: no global lock'] },
  { id: 'M13', title: 'pending References retry forever (no attempt limit)', mechanism: 'bounded retries → REFERENCE_NOT_FOUND',
    edits: [ON('export const MAX_ATTEMPTS = 8;', 'export const MAX_ATTEMPTS = 1_000_000;', 'src/application/pending-reference-worker.ts')],
    predicted: ['pending-reference-worker: 8 attempts'] },
  { id: 'M14', title: 'map transient failures to 500 instead of 503 + Retry-After', mechanism: 'the API tells "retry later" apart from "broken"',
    edits: [ON("[TransientError, 503, 'TEMPORARILY_UNAVAILABLE'],", "[TransientError, 500, 'INTERNAL_ERROR'],", 'src/interfaces/http/exception-filter.ts')],
    predicted: ['wagering-api lock_timeout 503', 'commit-boundary connection killed'] },
];

const sh = async (cmd: string[], cwd: string, env: Record<string, string> = {}, timeoutMs = 900_000) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { code: await p.exited, out: out + err, timedOut };
};
const psql = (sql: string) => sh(['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'jungle', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], REPO);

async function runMutant(m: Mutant, tests: string[]) {
  const dir = mkdtempSync(join(process.env.MUTATION_TMP ?? tmpdir(), `junglegame-${m.id}-`));
  try {
    const files = (await sh(['git', 'ls-files', '-co', '--exclude-standard', '-z'], REPO)).out.split('\0').filter(Boolean);
    await sh(['sh', '-c', `git ls-files -co --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C '${dir}'`], REPO);
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    for (const e of m.edits) {
      const path = join(dir, e.file), src = readFileSync(path, 'utf8');
      const n = src.split(e.find).length - 1;
      if (n !== 1) throw new Error(`${m.id}: edit target found ${n} times in ${e.file} (the code moved: update the mutant)`);
      writeFileSync(path, src.replace(e.find, e.replace));
    }
    const db = 'postgres://jungle:jungle@localhost:55432/jungle_mut', appDb = 'postgres://jungle_app:jungle_app@localhost:55432/jungle_mut';
    await psql('drop database if exists jungle_mut with (force)');
    await psql('create database jungle_mut');
    const mig = await sh(['bunx', '--bun', 'mikro-orm', 'migration:up'], dir, { DATABASE_URL: db });
    if (mig.code !== 0) throw new Error(`${m.id}: migration failed\n${mig.out.slice(-2000)}`);
    const t0 = Date.now();
    const r = await sh(['bun', 'test', ...tests], dir, { DATABASE_URL: db, APP_DATABASE_URL: appDb });
    const lines = r.out.split('\n');
    const why: Record<string, string> = {}; // the assertion that failed, from the lines bun prints just before "(fail) name"
    const failed = [...new Set(lines.flatMap((l, i) => {
      const m = l.match(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/);
      if (!m) return [];
      why[m[1]] ??= lines.slice(Math.max(0, i - 15), i).filter((x) => /^error:|^\s*(Expected|Received)|^[-+] /.test(x)).slice(0, 4).map((x) => x.trim()).join(' / ');
      return [m[1]];
    }))];
    const summary = r.out.match(/^ *(\d+) pass\n *(\d+) fail/m);
    return { id: m.id, title: m.title, mechanism: m.mechanism, predicted: m.predicted, files: files.length, exitCode: r.code, seconds: Math.round((Date.now() - t0) / 1000),
      pass: Number(summary?.[1] ?? 0), fail: Number(summary?.[2] ?? 0), killed: r.code !== 0 && failed.length > 0, error: r.code !== 0 && failed.length === 0 ? (r.timedOut ? 'timeout' : 'no named failing test (infra crash?)') : '', failed, why };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const wanted = process.argv.slice(2);
  const tests = (process.env.MUTATION_TESTS ?? 'test/unit test/integration test/concurrency test/property test/experiments test/multi-instance').split(' ');
  const results = [];
  for (const m of MUTANTS.filter((m) => !wanted.length || wanted.includes(m.id) || m.id === 'M0')) {
    console.log(`${m.id} ${m.title} ...`);
    const r = await runMutant(m, tests);
    console.log(`  ${r.error ? `ERROR (${r.error})` : r.killed ? 'KILLED' : 'survived'} in ${r.seconds}s: ${r.fail} failing test(s)`);
    for (const f of r.failed) console.log(`    - ${f}\n        ${r.why[f]}`);
    results.push(r);
  }
  await psql('drop database if exists jungle_mut with (force)');
  const md = ['# Mutation results (generated by `bun test/mutations/run.ts`)', '', `Run ${new Date().toISOString()}; suite: \`${tests.join(' ')}\`.`, '',
    '| Mutant | Mechanism removed | Result | Failing tests | Predicted killers |', '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} ${r.title} | ${r.mechanism} | ${r.id === 'M0' ? (r.killed ? '**control failed: flaky**' : r.error ? `**ERROR: ${r.error}**` : 'control green') : r.error ? `**ERROR: ${r.error}**` : r.killed ? '**killed**' : 'survived'} (${r.pass} pass / ${r.fail} fail, ${r.seconds}s) | ${r.failed.map((f) => f.replace(/\|/g, '/')).join('<br>') || '-'} | ${r.predicted.join('; ') || '-'} |`)];
  mkdirSync(join(REPO, 'reports/testing'), { recursive: true });
  const out = join(REPO, 'reports/testing/mutation-results');
  writeFileSync(`${out}.md`, md.join('\n') + '\n');
  writeFileSync(`${out}.json`, JSON.stringify(results, null, 2) + '\n');
  console.log(`wrote ${out}.md`);
}
