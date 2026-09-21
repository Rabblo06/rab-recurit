#!/bin/sh
set -e

# This script is PID 1 of the API container while it migrates. PID 1 has no
# default signal action, so without a handler a SIGTERM sent during this phase
# (a deploy that replaces the container mid-boot) is ignored until the
# orchestrator's SIGKILL deadline. Each step therefore runs as a background
# child that we `wait` on: `wait` is interrupted by a trapped signal, the child
# is terminated (migrations run in a transaction, so an aborted one rolls back
# cleanly) and we exit immediately. Once `exec node main.js` runs, main.js
# installs its own handlers (see engine/utils/early-boot-signal-guard.ts).
CHILD=""
abort() {
  echo "start.sh: received a stop signal during startup — aborting"
  if [ -n "$CHILD" ]; then kill "$CHILD" 2>/dev/null || true; fi
  exit 0
}
trap abort TERM INT

run_step() {
  "$@" &
  CHILD=$!
  wait "$CHILD"
  CHILD=""
}

# Migrations run against the direct (unpooled) connection — see
# render.yaml's comment. DATABASE_URL_UNPOOLED falls back to DATABASE_URL
# itself so this script also works unchanged in docker-compose, where
# there's no pooler and no separate unpooled URL.
export MIGRATION_DATABASE_URL="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"
run_step env DATABASE_URL="$MIGRATION_DATABASE_URL" node packages/rab-server/dist/database/typeorm/scripts/setup-db.js

# Env-driven first-Platform-Admin bootstrap — no-ops instantly unless
# BOOTSTRAP_ADMIN_EMAIL/PASSWORD are set (see bootstrap-admin.command.ts).
# Runs as rab_owner, same as migrations above, since platform_admin's own
# first-grant path is deliberately only writable that way.
run_step env DATABASE_URL="$MIGRATION_DATABASE_URL" node packages/rab-server/dist/command/main.js bootstrap-admin

trap - TERM INT
exec node packages/rab-server/dist/main.js
