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

# Docker hardening H6: the container isolation this process actually received, compared with what
# docker-compose.production.yml declares for rab-api (uid 1000, no capability at all, no-new-privileges, read-only root, PID
# and memory limits). Names and flags only; no value from the environment is printed.
# CREWFLOW_RUNTIME_ISOLATION (owner decision "never drop a security setting silently"; strict values):
#   unset / empty / warn   report one line ("as declared", or a WARNING naming each gap) and start anyway — the default,
#                          because some platforms drop these compose keys (OpenShip's compose import does not model
#                          user/read_only/cap_*/security_opt/pids_limit; THREAT-MODEL.md, Docker hardening H6);
#   enforce                any gap (an unreadable value included) REFUSES to start (exit 64);
#   anything else          refuses to start (exit 64).
case "${CREWFLOW_RUNTIME_ISOLATION:-warn}" in
  warn) isolation_mode=warn ;;
  enforce) isolation_mode=enforce ;;
  *) refuse 'CREWFLOW_RUNTIME_ISOLATION must be "warn" or "enforce" (unset or empty = warn).' ;;
esac
isolation_report() {
  capbnd=$(sed -n 's/^CapBnd:[[:space:]]*//p' /proc/self/status 2>/dev/null || true)
  nnp=$(sed -n 's/^NoNewPrivs:[[:space:]]*//p' /proc/self/status 2>/dev/null || true)
  rootopts=$(awk '$2 == "/" { o = $4 } END { print o }' /proc/self/mounts 2>/dev/null || true)
  case ",$rootopts," in
    ,,) root=unknown ;;
    *,ro,*) root=read-only ;;
    *) root=writable ;;
  esac
  pids=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || true)
  mem=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)
  uid=$(id -u 2>/dev/null || echo unknown)
  gaps=""
  if [ "$uid" = 0 ]; then gaps="$gaps; running as root"; elif [ "$uid" != 1000 ]; then gaps="$gaps; uid $uid, expected 1000"; fi
  [ "$capbnd" = 0000000000000000 ] || gaps="$gaps; capabilities in the bounding set (CapBnd=${capbnd:-unknown})"
  [ "$nnp" = 1 ] || gaps="$gaps; no-new-privileges is off"
  [ "$root" = read-only ] || gaps="$gaps; root filesystem is $root"
  case "$pids" in max) gaps="$gaps; no PID limit" ;; '') gaps="$gaps; PID limit unreadable" ;; esac
  case "$mem" in max) gaps="$gaps; no memory limit" ;; '') gaps="$gaps; memory limit unreadable" ;; esac
  summary="uid=$uid CapBnd=${capbnd:-unknown} NoNewPrivs=${nnp:-unknown} root=$root pids.max=${pids:-unknown} memory.max=${mem:-unknown} mode=$isolation_mode"
  if [ -z "$gaps" ]; then
    echo "api-prestart: runtime isolation as declared: $summary"
  elif [ "$isolation_mode" = enforce ]; then
    refuse "runtime isolation weaker than declared and CREWFLOW_RUNTIME_ISOLATION=enforce (${gaps#; }): $summary"
  else
    echo "api-prestart: WARNING runtime isolation weaker than docker-compose.production.yml declares (${gaps#; }): $summary - starting anyway; report it (THREAT-MODEL.md, Docker hardening H6)" >&2
  fi
}
isolation_report

echo "api-prestart: checking the schema is current (restricted runtime role, read-only)"
if ! run_step node "$SCRIPTS/check-pending-migrations.js"; then
  echo "api-prestart: REFUSED - the schema is behind this code (or the runtime role is wrong). Run rab-migrate (deploy:prepare) for this release first." >&2
  exit 65
fi

trap - TERM INT
exec node packages/rab-server/dist/main.js
