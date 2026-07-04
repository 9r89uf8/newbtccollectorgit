# Deployment

This repo deploys the collector by pushing `main` to GitHub, then running the deploy script on the droplet. The droplet script pulls `origin/main`, installs dependencies, runs database setup, installs the systemd unit, restarts the collector service, and prints service status.

## When to deploy

Run the droplet deploy script only after changes that affect the collector or its runtime dependencies, such as:

- `collector/`
- `db/schema.sql`
- `scripts/setupDb.mjs`
- `ops/systemd/`
- `package.json` or `package-lock.json` when needed by the collector

Do not deploy for docs-only, README-only, local dashboard-only, or styling-only changes unless the user explicitly asks.

## Standard flow

From the repo root:

```bash
git status --short
npm run build
git add <changed-files>
git commit -m "Describe the collector/runtime change"
git push origin main
ssh root@$DROPLET_PUBLIC_IPV4 "cd /opt/newbtccollector && bash scripts/deploy.sh"
```

If `$DROPLET_PUBLIC_IPV4` is not exported in the shell, read it from `.env` and substitute the IP in the `ssh` command.

## Codex sandbox notes

In this environment, committing and pushing can require elevated tool permissions:

- If `git commit` fails because `.git/index.lock` cannot be created, rerun the same commit command with elevated filesystem permission.
- If `git push origin main` fails because network/proxy access is blocked, rerun the same push command with elevated network permission.
- Only run the droplet deploy command after the push succeeds.

## Verification

After deploy, check the script output for:

- Fast-forward to the pushed commit.
- `npm run db:setup` completes.
- `newbtccollector-collector.service` is `active (running)`.

Optional live sanity check:

```bash
node --input-type=module -e "const env=await import('./lib/env.js'); env.loadLocalEnv(); const db=await import('./lib/db.js'); const r=await db.query('select * from collector_heartbeats order by last_seen_at desc limit 1'); console.log(JSON.stringify(r.rows, null, 2)); await db.closePool();"
```