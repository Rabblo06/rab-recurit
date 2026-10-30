#!/bin/sh
# API start (the image's default command; Phase B P7). Runs from /app (the image WORKDIR).
#
# THE API NEVER MIGRATES. Migrations are applied only by the one-off `rab-migrate` process (deploy-prepare.js, with the
# migration-only credential in ITS environment and nowhere else), which the API is started after. This script:
#   1. refuses to start when any migration/bootstrap credential or approval reached the API's environment: the long-running
#      API must never hold one (the old opt-in prestart migration step, CREWFLOW_PRESTART_MIGRATION_DATABASE_URL, is
#      retired and now refused like the others);
#   2. runs a read-only check AS THE API'S OWN RESTRICTED RUNTIME ROLE (check-pending-migrations.js: crewflow_app,
#      PG_DATABASE_URL) and refuses to start when the schema is behind this code;
#   3. execs main.js (which runs its own boot gates as well).
# The Worker never runs this. Nothing here writes to the database.
set -eu

SCRIPTS=packages/rab-server/dist/database/typeorm/scripts

refuse() {
  echo "api-prestart: REFUSED - $1" >&2
  exit 64
}

# Signal handling while this shell is PID 1: a stop during the check terminates the child and exits.
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

# Security review L-4: these two loops are a literal copy of the shared list in
# packages/rab-server/src/database/typeorm/core/never-in-runtime-env.ts (forbiddenRuntimeEnvNames('api')), which main.js
# enforces in-process as well; never-in-runtime-env.spec.ts fails the server build when they drift. Strict BY NAME here,
# DB_TARGET included: the in-process guard alone tolerates DB_TARGET=local|test in a non-production runtime (local
# `yarn start` with a developer .env), and this script only ever runs inside the image, where no compose file injects one.
for name in DATABASE_URL_UNPOOLED CREWFLOW_MIGRATION_DATABASE_URL CREWFLOW_PRESTART_MIGRATION_DATABASE_URL CREWFLOW_PROVISIONER_DATABASE_URL \
    CREWFLOW_BOOTSTRAP_PASSWORD CREWFLOW_APP_BOOTSTRAP_PASSWORD CREWFLOW_MIGRATOR_PASSWORD CREWFLOW_MIGRATION_PHASE \
    CREWFLOW_MIGRATION_APPROVED ALLOW_PRODUCTION_DB_COMMANDS DB_TARGET CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service (the API never migrates; migrations run only in rab-migrate)."; fi
done
# Phase B (ops): the one-off operations container's variables (its own crewflow_app URL, its marker, the operator label) belong
# to `docker compose --profile ops run --rm rab-ops ...` only. pg-config.ts refuses them in the API process as well.
for name in CREWFLOW_OPS_RUN PG_OPS_APP_DATABASE_URL CREWFLOW_OPS_ACTOR_SOURCE CREWFLOW_OPS_ACTOR_ID CREWFLOW_OPS_CHANGE_REF; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service (it belongs to the one-off ops container only)."; fi
done

echo "api-prestart: checking the schema is current (restricted runtime role, read-only)"
if ! run_step node "$SCRIPTS/check-pending-migrations.js"; then
  echo "api-prestart: REFUSED - the schema is behind this code (or the runtime role is wrong). Run rab-migrate (deploy:prepare) for this release first." >&2
  exit 65
fi

trap - TERM INT
exec node packages/rab-server/dist/main.js
