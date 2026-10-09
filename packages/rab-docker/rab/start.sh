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
#
# P1C.2: this is `crewflow` now (same role as DATABASE_URL — see
# docker-compose.yml's own comment), which is sufficient for every migration
# EXCEPT the one-time role-bootstrap migration
# (CrewflowSingleCredentialRoleArchitecture1786682000000), which fails CLOSED
# under `crewflow` by design and must be run once, manually, via a genuinely
# privileged connection before a brand-new volume's first boot — see that
# migration file's own doc comment. This script never carries that
# privileged credential; it only ever sees DATABASE_URL_UNPOOLED, which is
# `crewflow` in every normal deployment.
export MIGRATION_DATABASE_URL="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}"
run_step env DATABASE_URL="$MIGRATION_DATABASE_URL" node packages/rab-server/dist/database/typeorm/scripts/setup-db.js

# Env-driven first-Platform-Admin bootstrap — no-ops instantly unless
# BOOTSTRAP_ADMIN_EMAIL/PASSWORD are set (see bootstrap-admin.command.ts).
# Runs as the same migration-direct connection above (`crewflow`), since
# platform_admin's own first-grant path needs the narrow grants that role
# carries on core.platform_admin, not a separate owner credential.
run_step env DATABASE_URL="$MIGRATION_DATABASE_URL" node packages/rab-server/dist/command/main.js bootstrap-admin

trap - TERM INT
exec node packages/rab-server/dist/main.js
