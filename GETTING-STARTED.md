# Getting started

The `main` branch contains the [Jungle Gaming backend challenge](Requirements.md) implementation, test suite, and test commands.

## 1. Prerequisites (once)

- **Access** to this private repository: ask the owner to invite your GitHub account.
- **Bun** 1.4 or newer (tested with 1.4.2): `curl -fsSL https://bun.sh/install | bash`.
- **Docker** with Compose v2 (`docker compose version` works). Podman with `podman compose` also works.
- **git**, **curl**.
- **flock**: built into Linux (util-linux). On macOS: `brew install flock`. On Windows, use WSL2.
  On native Windows the SIGTERM/SIGSTOP tests are skipped and the crash tests check "exited" instead of "killed by SIGKILL"; WSL/Linux runs them fully.
- Free local ports **55432** (PostgreSQL) and **54566** (LocalStack SQS).

```sh
git clone https://github.com/Ethernalred/Jungle-Gaming-Challenge.git
cd Jungle-Gaming-Challenge
mkdir -p ~/.cache        # the test lock file lives here
```

## 2. Run `main` (the solution)

```sh
git switch main
bun install
docker compose up -d --wait            # PostgreSQL + LocalStack; creates the three SQS queues
bunx --bun mikro-orm migration:up      # always with --bun
```

Then pick what you want to see:

| Command | What it does | Time |
|---|---|---|
| `bun run test:unit` | domain unit tests, no containers needed | < 1 s |
| `flock ~/.cache/junglegame-db.lock bun test` | the whole suite (expect 161 pass, 0 fail) | 2–3 min |
| `bun run playbook --step` | runs the test groups in 11 chapters, pausing before each | ~2.5 min |
| `bun run dashboard` | runs the tour and writes `reports/testing/dashboard.html`: open it in a browser | ~3 min |
| `bun run test:mutants` | mutation testing: breaks one safety mechanism at a time and shows which tests catch it | ~45 min |
| `bun start` | the app on port 3000 (curl examples in [README.md](README.md)) | |

How to read the results:

- **Tests named `F1:` … `F10:` are pinned bugs.** They are green while the bug is still there, and turn red when it is fixed (or if their setup broke).

## 3. Rules that save time

- **Database tests run under the lock.** Anything touching PostgreSQL or SQS shares one database, so run it through `flock ~/.cache/junglegame-db.lock bun test …`. `bun run playbook`, `dashboard`, `test:mutants` and `test:load` take the lock themselves.
- **Never use `bunx mikro-orm` without `--bun`.** Without it, the CLI silently runs under Node.
- The test database is never wiped between runs; tests only look at the rows they create. To start clean: `docker compose down -v && docker compose up -d --wait && bunx --bun mikro-orm migration:up`.

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| `port is already allocated` on 55432 / 54566 | another Postgres/LocalStack is running: stop it, or change the ports in `docker-compose.yml` and set `DATABASE_URL`, `APP_DATABASE_URL`, `SQS_ENDPOINT` (see README "Ports and environment") |
| `flock: cannot open lock file` | `mkdir -p ~/.cache` |
| `flock: command not found` (macOS) | `brew install flock` |
| `docker compose up --wait` hangs on localstack | the first start pulls the image; wait, or check `docker compose logs localstack` |
| tests time out on a slow or busy machine | close heavy apps and rerun; each DB test file allows 60 s or more per test |
| on `main`, a schema error such as `relation "wallets" does not exist` | run `bunx --bun mikro-orm migration:up` against the configured database |
