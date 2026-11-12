/**
 * One-page static dashboard of the guided suite: bun run dashboard  ->  reports/testing/dashboard.html
 * Runs playbook chapters 1-11 (mutation chapter 12 is NOT re-run: it reads the last reports/testing/mutation-results.json)
 * Needs the stack up; `bun run dashboard` takes the shared DB lock.
 */
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
const DOCS = 'reports/testing';
const tmp = `${tmpdir()}/dashboard-${process.pid}.json`;

const p = Bun.spawn(['bun', 'test/playbook.ts', ...Array.from({ length: 11 }, (_, i) => String(i + 1)), '--json', tmp], { stdout: 'inherit', stderr: 'inherit' });
await p.exited; // a red chapter still gets a report: the dashboard shows it
type Test = { name: string; status: 'pass' | 'fail'; pinned: boolean };
type Chapter = { n: number; title: string; proves: string; note?: string; pass: number; fail: number; seconds: number; tests: Test[] };
const chapters: Chapter[] = await Bun.file(tmp).json();
await Bun.file(tmp).delete();

type Mutant = { id: string; title: string; mechanism: string; killed: boolean; failed: string[]; pass: number; fail: number; seconds: number; error?: string };
const mutants: Mutant[] = await Bun.file(`${DOCS}/mutation-results.json`).json().catch(() => []);

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const sha = (await Bun.$`git rev-parse --short HEAD`.nothrow().text()).trim() || 'unknown';
const pass = chapters.reduce((a, c) => a + c.pass, 0), fail = chapters.reduce((a, c) => a + c.fail, 0);
const pinned = chapters.reduce((a, c) => a + c.tests.filter((t) => t.pinned && t.status === 'pass').length, 0);

const chapterHtml = (c: Chapter) => `<section><h2><span class="badge ${c.fail ? 'bad' : 'ok'}">${c.fail ? 'FAIL' : 'PASS'}</span> Chapter ${c.n}: ${esc(c.title)}</h2>
<p>${esc(c.proves)}</p>${c.note ? `<p class="dim">${esc(c.note)}</p>` : ''}
<p><b>${c.pass}</b> pass, <b>${c.fail}</b> fail, ${c.seconds}s</p>
${c.tests.length ? `<details><summary>${c.tests.length} tests</summary><ul>${c.tests.map((t) => `<li class="${t.status}">${t.status === 'pass' ? '&#10003;' : '&#10007;'} ${esc(t.name)}${t.pinned ? ` <span class="pin">${t.status === 'pass' ? 'pinned bug: still present' : 'pinned bug: FIXED or setup broke'}</span>` : ''}</li>`).join('')}</ul></details>` : '<p class="dim">no per-test detail (junit report missing)</p>'}</section>`;

const status = (m: Mutant) => m.error ? 'error' : m.id === 'M0' ? 'control' : m.killed ? 'killed' : 'survived';
const mutantRow = (m: Mutant) => `<tr><td>${esc(m.id)}</td><td>${esc(m.title)}<br><span class="dim">${esc(m.mechanism)}</span></td><td><span class="badge ${{ killed: 'ok', control: 'ok', survived: 'bad', error: 'warn' }[status(m)]}">${status(m)}</span></td><td>${m.fail}</td>
<td>${m.failed?.length ? `<details><summary>${m.failed.length} named</summary><ul>${m.failed.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></details>` : esc(m.error ?? '')}</td></tr>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test suite dashboard</title><style>
:root{--bg:#fff;--fg:#1c2024;--dim:#60646c;--card:#f6f7f9;--line:#d9dce1;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700}
@media(prefers-color-scheme:dark){:root{--bg:#0f1114;--fg:#e6e8eb;--dim:#9aa0a8;--card:#181b20;--line:#2c3138;--ok:#3fb950;--bad:#ff6b6b;--warn:#d29922}}
body{margin:0 auto;max-width:1000px;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
h1{margin:.2em 0}h2{font-size:1.05em;margin:0 0 .3em}section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}
.dim{color:var(--dim)}.badge{font-size:.75em;font-weight:700;padding:1px 7px;border-radius:10px;border:1px solid currentColor}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.pin{color:var(--warn);font-size:.8em;border:1px solid var(--warn);border-radius:10px;padding:0 6px}ul{padding-left:1.2em;margin:.4em 0}li{list-style:none;margin-left:-1em}li.fail{color:var(--bad)}li.pass::first-letter{color:var(--ok)}
.top{display:flex;flex-wrap:wrap;gap:12px}.top div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 16px}.top b{font-size:1.6em;display:block}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}.wrap{overflow-x:auto}summary{cursor:pointer}
</style></head><body>
<h1>Test suite dashboard</h1>
<p class="dim">Generated ${esc(new Date().toISOString())} at commit ${esc(sha)} (working tree, uncommitted changes included)</p>
<div class="top"><div><b class="${fail ? 'bad' : 'ok'}">${pass}</b>passing</div><div><b class="${fail ? 'bad' : 'ok'}">${fail}</b>failing</div><div><b>${pinned}</b>pinned bugs still present</div><div><b>${mutants.filter((m) => m.killed).length}/${mutants.filter((m) => m.id !== 'M0').length}</b>mutants killed</div></div>
<h2 style="margin-top:1em">Chapters 1-11 (this run)</h2>${chapters.map(chapterHtml).join('')}
<h2>Chapter 12: mutation matrix (last full run, not re-run here)</h2>
<section class="wrap">${mutants.length ? `<table><tr><th>Mutant</th><th>Mechanism removed</th><th>Result</th><th>Failing tests</th><th>Which</th></tr>${mutants.map(mutantRow).join('')}</table>` : '<p class="dim">no mutation-results.json yet: run bun run test:mutants</p>'}</section>
<footer class="dim"><p><b>Pins.</b> Tests named F1, F2, ... document a known bug or limitation and are green while it is still there. If the bug is fixed the pin turns red: convert the pin into a normal regression test after verifying the fix. Mutants: each removes one correctness mechanism; "killed" means at least one named test failed.</p>
<p>Regenerate: <code>bun run dashboard</code> (stack up, takes the DB lock, about 3 minutes). Mutation results come from <code>bun run test:mutants</code>.</p></footer>
</body></html>`;
mkdirSync(DOCS, { recursive: true });
await Bun.write(`${DOCS}/dashboard.html`, html);
console.log(`\nwrote ${DOCS}/dashboard.html: ${pass} pass, ${fail} fail, ${pinned} pinned`);
export {};
