import { test } from 'bun:test';

/**
 * Pins a known bug or limitation: `test.failing` that only the BUG assertion can satisfy.
 * Plain `test.failing` is green whenever anything throws, so a broken setup (a missed barrier, a child that never
 * started) would look like "the bug is still there". Here setup runs first: if it throws or times out, the test returns
 * normally, which bun reports as a failure ("marked as failing but it passed"). Only `check` throwing keeps it green.
 */
export function pinned<T>(name: string, setup: () => Promise<T>, check: (s: T) => Promise<void> | void, setupMs = 60_000, opts: { skip?: boolean } = {}) {
  if (opts.skip) return test.skip(name, () => {}); // the caller's name says why
  test.failing(name, async () => {
    let s: T;
    try {
      const timedOut = Symbol('timeout');
      const r = await Promise.race([setup(), Bun.sleep(setupMs).then(() => timedOut)]);
      if (r === timedOut) throw new Error(`setup did not finish in ${setupMs} ms`);
      s = r as T;
    } catch (e) {
      console.error(`PIN SETUP BROKEN (${name}): ${(e as Error).message}`); // reported as a failure: setup must hold
      return;
    }
    await check(s);
  }, setupMs + 60_000);
}
