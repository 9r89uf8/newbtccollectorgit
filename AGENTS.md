NO TYPESCRIPT
NO DOCKER
NO NIGHT BACKUPS

DEPLOY SCRIPT RULE
Only run the Droplet deploy script after changes that affect the collector or its runtime dependencies.
Examples: collector/, db/schema.sql, scripts/setupDb.mjs, ops/systemd/, package.json/package-lock.json when needed by the collector.
Do not run the Droplet deploy script for docs-only, README-only, local dashboard-only, or styling-only changes unless the user explicitly asks.
When it is needed, run it only after the relevant changes have been committed and pushed to GitHub:
ssh root@DROPLET_PUBLIC_IPV4 "cd /opt/newbtccollector && bash scripts/deploy.sh"

DEPLOYMENT DETAILS
See [deployment.md](deployment.md) for the commit, push, droplet deploy, and verification flow.