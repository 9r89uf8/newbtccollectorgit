#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/newbtccollector}"
SERVICE_NAME="${SERVICE_NAME:-newbtccollector-collector}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "run this deploy script as root, or through SSH as root"
fi

cd "$APP_DIR" || fail "could not cd to $APP_DIR"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$APP_DIR is not a git repo"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "$DEPLOY_BRANCH" ]; then
  fail "expected branch $DEPLOY_BRANCH, found $current_branch"
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short
  fail "tracked files are dirty on the Droplet; commit, stash, or reset them before deploy"
fi

log "fetching origin/$DEPLOY_BRANCH"
git fetch origin "$DEPLOY_BRANCH"

local_rev="$(git rev-parse HEAD)"
remote_rev="$(git rev-parse "origin/$DEPLOY_BRANCH")"

if [ "$local_rev" = "$remote_rev" ]; then
  log "repo already at latest commit $local_rev"
else
  log "updating $local_rev -> $remote_rev"
  git merge --ff-only "origin/$DEPLOY_BRANCH"
fi

log "installing dependencies"
npm install

log "running database setup"
unset DATABASE_URL
npm run db:setup

unit_src="$APP_DIR/ops/systemd/$SERVICE_NAME.service"
unit_dest="/etc/systemd/system/$SERVICE_NAME.service"
if [ -f "$unit_src" ]; then
  log "installing systemd unit"
  cp "$unit_src" "$unit_dest"
  systemctl daemon-reload
fi

log "restarting $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

log "service status"
systemctl status "$SERVICE_NAME" --no-pager

log "deploy complete"