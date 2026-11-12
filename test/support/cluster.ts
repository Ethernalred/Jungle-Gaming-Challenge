import { tmpdir } from 'node:os';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { realSqs } from './events';
import { queueUrl, until } from './queue';

/** Real app processes (`bun src/main.ts`) sharing one PostgreSQL and one queue. Every live one is killed by PID when the test process exits. */
export type Instance = { port: number; base: string; proc: ReturnType<typeof Bun.spawn>; alive: () => boolean; stop: (signal?: NodeJS.Signals) => Promise<void> };
const live = new Set<Instance>();
const killAll = () => { for (const i of live) try { process.kill(i.proc.pid, 'SIGKILL'); } catch { /* already gone */ } };
process.on('exit', killAll);
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { killAll(); process.exit(1); });

/**
 * True when the process ended by a hard kill. POSIX: signalCode is SIGKILL. Windows has no signals: a killed process just
 * reports an exit code, so any exit counts. Sound there because the fault hook (or the test's own kill) is the only thing
 * that ends a long-running server process at that point, so any exit proves the crash landed.
 */
export const diedHard = (proc: { exitCode: number | null; signalCode: number | string | null }, platform: string = process.platform) =>
  platform === 'win32' ? proc.exitCode !== null || proc.signalCode !== null : proc.signalCode === 'SIGKILL';

const used = new Set<number>();
const up = (base: string) => fetch(`${base}/health/live`).then((r) => r.ok, () => false);

export async function startInstance(env: Record<string, string> = {}): Promise<Instance> {
  for (let attempt = 0; attempt < 5; attempt++) {
    // below the ephemeral range (32768+), else an outgoing connection may hold the port and the child dies with EADDRINUSE
    let port = 20000 + Math.floor(Math.random() * 12000);
    while (used.has(port)) port++;
    used.add(port);
    const proc = Bun.spawn(['bun', 'src/main.ts'], {
      env: { ...process.env, PORT: String(port), QUEUE_VISIBILITY_S: '3', QUEUE_WAIT_S: '1', ...env },
      stdout: Bun.file(`${tmpdir()}/junglegame-mi-${port}.out`), stderr: Bun.file(`${tmpdir()}/junglegame-mi-${port}.err`),
    });
    const inst: Instance = {
      port, base: `http://localhost:${port}`, proc, alive: () => proc.exitCode === null && proc.signalCode === null,
      stop: async (signal = 'SIGKILL') => { if (inst.alive()) proc.kill(signal); await proc.exited; live.delete(inst); },
    };
    live.add(inst);
    const ready = await until(async () => inst.alive() && (await up(inst.base)), 30_000);
    if (ready) return inst;
    await inst.stop();
  }
  throw new Error('app instance did not start');
}

export const startCluster = (n: number, env: Record<string, string> = {}) => Promise.all(Array.from({ length: n }, () => startInstance(env)));
export const stopAll = (instances: Instance[], signal: NodeJS.Signals = 'SIGKILL') => Promise.all(instances.map((i) => i.stop(signal)));

export async function queueDepth() {
  const a = (await realSqs.send(new GetQueueAttributesCommand({ QueueUrl: await queueUrl(), AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }))).Attributes!;
  return Number(a.ApproximateNumberOfMessages) + Number(a.ApproximateNumberOfMessagesNotVisible);
}
