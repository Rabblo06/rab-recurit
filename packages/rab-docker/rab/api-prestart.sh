#!/bin/sh
# Twenty-parity Phase 7 — OPT-IN api prestart. PROPOSAL ONLY: no default compose file runs this (owner approval pending;
# see docs/evidence/server-path-provisioning-2026-10-22/proposed/). Runs from /app (the image WORKDIR).
#
# Twenty migrates from its container entrypoint on every server start, warns and continues on failure, and takes no lock
# (twentyhq/twenty@ea1a68e3 packages/twenty-docker/twenty/entrypoint.sh). This keeps the "api start triggers it" shape
# but is DISABLED by default and fails closed:
#   1. Without CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations nothing privileged runs; a migration credential
#      present WITHOUT approval refuses the start (it must not sit in a long-running service's environment).
#   2. With approval, the one-time credential CREWFLOW_PRESTART_MIGRATION_DATABASE_URL is handed ONLY to a short-lived child
#      (prestart-migrate.js) under a minimal `env -i` environment. That child takes a PostgreSQL advisory lock (replicas
#      never migrate concurrently), applies each pending migration once, and exits. Any failure stops here: main.js never
#      starts.
#   3. A read-only check as the restricted runtime role (check-pending-migrations.js) refuses the start if anything is
#      still pending — the "pending without approval" case.
#   4. main.js is started with `exec env -u ...`: execve replaces this shell with a process whose environment no longer
#      contains any migration variable (/proc/<pid>/environ included). runtime-database-guard.ts refuses to boot if one
#      ever does reach it.
# The Worker never runs this. Never resets a database. The credential still exists in the orchestrator's service config
# for that deploy: the operator removes it (and the approval) right after, exactly as for rab-migrate.
set -eu

SCRIPTS=packages/rab-server/dist/database/typeorm/scripts
APPROVAL="${CREWFLOW_MIGRATION_APPROVED:-}"
MURL="${CREWFLOW_PRESTART_MIGRATION_DATABASE_URL:-}"

refuse() {
  echo "api-prestart: REFUSED - $1" >&2
  exit 64
}

# Signal handling while this shell is PID 1 (same pattern as start.sh): a stop during the migration step terminates the
# child (its migration transaction rolls back) and exits.
CHILD=""
abort() {
  echo "api-prestart: received a stop signal during startup - aborting"
  if [ -n "$CHILD" ]; then kill "$CHILD" 2>/dev/null || true; fi
  exit 0
}
trap abort TERM INT
run_step() {
  "$@" &
  CHILD=$!
  STATUS=0
  wait "$CHILD" || STATUS=$?
  CHILD=""
  return "$STATUS"
}

for name in DATABASE_URL_UNPOOLED CREWFLOW_MIGRATION_DATABASE_URL CREWFLOW_PROVISIONER_DATABASE_URL CREWFLOW_BOOTSTRAP_PASSWORD CREWFLOW_APP_BOOTSTRAP_PASSWORD CREWFLOW_MIGRATION_PHASE; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service."; fi
done

if [ -n "$MURL" ] && [ "$APPROVAL" != "apply-pending-migrations" ]; then
  refuse "CREWFLOW_PRESTART_MIGRATION_DATABASE_URL is set but this start is not approved (CREWFLOW_MIGRATION_APPROVED). Remove the credential or approve the run."
fi

if [ "$APPROVAL" = "apply-pending-migrations" ]; then
  if [ -z "$MURL" ]; then refuse "approved, but CREWFLOW_PRESTART_MIGRATION_DATABASE_URL (the one-time migration connection) is not set."; fi
  case "$MURL" in
    *-pooler.*) refuse "CREWFLOW_PRESTART_MIGRATION_DATABASE_URL is a pooled (-pooler) host; session advisory locks need the direct host." ;;
  esac
  if [ -z "${DB_TARGET:-}" ]; then refuse "approved, but DB_TARGET is not set for this run."; fi
  echo "api-prestart: approved migration step starting (short-lived child, advisory-locked)"
  if ! run_step env -i PATH="$PATH" HOME="${HOME:-/tmp}" NODE_ENV="${NODE_ENV:-production}" RAB_RUNTIME_ENV="${RAB_RUNTIME_ENV:-}" \
      DB_TARGET="$DB_TARGET" ALLOW_PRODUCTION_DB_COMMANDS="${ALLOW_PRODUCTION_DB_COMMANDS:-}" \
      CREWFLOW_MIGRATION_APPROVED="$APPROVAL" DATABASE_URL="$MURL" DATABASE_URL_UNPOOLED="$MURL" \
      node "$SCRIPTS/prestart-migrate.js"; then
    echo "api-prestart: REFUSED - the approved migration step failed; the API will not start." >&2
    exit 70
  fi
fi

SCRUB="-u CREWFLOW_PRESTART_MIGRATION_DATABASE_URL -u CREWFLOW_MIGRATION_APPROVED -u ALLOW_PRODUCTION_DB_COMMANDS -u DB_TARGET"
echo "api-prestart: checking the schema is current (restricted runtime role)"
# shellcheck disable=SC2086
if ! run_step env $SCRUB node "$SCRIPTS/check-pending-migrations.js"; then
  echo "api-prestart: REFUSED - the schema is behind this code and this start is not an approved migration run." >&2
  exit 65
fi

trap - TERM INT
# shellcheck disable=SC2086
exec env $SCRUB node packages/rab-server/dist/main.js
