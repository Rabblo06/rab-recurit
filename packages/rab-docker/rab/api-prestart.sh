#!/bin/sh
# API start: rab-api's ENTRYPOINT in every deploy compose file (DB-SETUP; also the image's default command). Runs from /app
# (the image WORKDIR).
#
# DB-SETUP (Twenty Helm model, OWNER-DB-FINAL.md Part A): this container NEVER receives PG_DATABASE_URL, in any form (only the
# one-shot db-setup service does: the admin URL, an existing crewflow_owner URL, or the bundled db's). This script is PID 1
# (compose `entrypoint: ["./api-prestart.sh"]`, no compose init), refuses a PG_DATABASE_URL in its environment (exit 64),
# builds the crewflow_owner URL from the credential-free target file and the crewflow_owner password file db-setup wrote
# (both read-only), then execs the init: `exec /sbin/tini -s -- node packages/rab-server/dist/main.js`. Run with arguments (the owner CLI
# one-off: `docker compose run --rm --no-deps rab-api node packages/rab-server/dist/command/main.js <command>`), it does
# the same refusals and builds the same crewflow_owner URL, then `exec /sbin/tini -s -- "$@"`: nothing migrates or registers.
#
# Owner-login architecture (owner's FINAL decision 2026-11-04; M0 §7): the API, the Worker and the migrate child all use the
# ONE database URL, PG_DATABASE_URL (the schema-owning crewflow_owner login). This script:
#   1. validates the database start-up settings — a literal copy of database/owner-login/runtime-db-config.ts between the
#      BEGIN/END markers below (runtime-db-config.spec.ts runs this copy against the TypeScript parser and fails on drift):
#      DISABLE_DB_MIGRATIONS (true | false; true = this process never migrates — O3 C1), CREWFLOW_MIGRATE_ON_START is
#      REQUIRED here (true | false) unless DISABLE_DB_MIGRATIONS=true, CREWFLOW_MIGRATION_APPROVAL_MODE (none | token),
#      the removed CREWFLOW_DB_MODE, CREWFLOW_UPGRADE_FAILURE and CREWFLOW_UPGRADE_FAILURE_POLICY are refused (exit 64;
#      OWNER-DB-ULTIMATE Part B3 removed the C3 choices). The retired CREWFLOW_UPGRADE_INCOMPLETE is refused too (exit 64);
#   2. refuses to start when a second database URL, a role password (PG_DATABASE_PASSWORD included: only compose reads it,
#      for the bundled db), migration/command authority or an operations variable
#      reached the API's environment (exit 64). The one exception is the per-release approval token
#      (CREWFLOW_MIGRATION_APPROVED) when CREWFLOW_MIGRATE_ON_START=true AND CREWFLOW_MIGRATION_APPROVAL_MODE=token: it is
#      taken out of this shell's environment first, handed ONLY to the short-lived migrate child, and never reaches main.js;
#   2b. DB-SETUP (Twenty Helm model): refuses any PG_DATABASE_URL (64); builds the crewflow_owner runtime URL from db-setup's
#      credential-free target file and its crewflow_owner password file, waiting (bounded) for both (details below);
#   3. CREWFLOW_MIGRATE_ON_START=true (and DISABLE_DB_MIGRATIONS not true): runs the short-lived migrate child (Agent 1:
#      migration lock, fresh-install classifier, post-checks, the upgrade logbook). Exit 0 = current / applied / ledger
#      ahead; 70 = every migration applied but an upgrade COMMAND failed (OWNER-DB-ULTIMATE Part B3: serve, loud WARNING,
#      /healthz upgrade:"failed"); 66 = a migration failed (never serves; the next start retries it);
#      69 = migration lock timeout (retried with bounded backoff); anything else = no start.
#      Otherwise (CREWFLOW_MIGRATE_ON_START=false, or DISABLE_DB_MIGRATIONS=true): the read-only pending-migration check
#      (exit 65 when the schema is behind);
#   4. O3 C2 (like Twenty's entrypoint): unless DISABLE_CRON_JOBS_REGISTRATION=true, registers every scan's BullMQ job
#      scheduler (one-shot packages/rab-worker/dist/register-schedulers.js: fixed ids, idempotent). A registration failure is
#      a loud WARNING and the API starts anyway; the consume-only Worker reports any missing scheduler as an ERROR;
#   5. execs main.js ONLY after exit 0 or a verified 70 (main.js runs its own boot gates as well; a 70 leaves no migration
#      pending, so its gate 7 passes unchanged). A fresh-install failure never serves: the child never reports 70 for one,
#      and the relay below vetoes a 70 result that names one, names a failed migration, or names no failed command.
# Every failure other than a configuration refusal waits CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS (default 15, 0-300) before
# exiting, so a restart policy cannot turn a broken release into a tight restart storm against the database.
# The Worker never runs this, and never migrates: its entrypoint is worker-start.sh (derive + swap only, never the admin).
set -eu

SCRIPTS=packages/rab-server/dist/database/typeorm/scripts

refuse() {
  echo "api-prestart: REFUSED - $1" >&2
  exit 64
}

# Signal handling while this shell is PID 1: a stop during a step terminates the child and exits.
# O3 T8a-TMP trade-off (stated, not silent): the migrate child's output is captured by a command substitution (no file is
# ever written: rab-api runs read_only with no tmpfs writable by its uid 1000; docker-compose.image.yml mounts a 0555,
# root-owned /tmp, not writable by the API's uid 1000, only as the OpenShip import guard), and a POSIX shell runs a trap
# only after a command substitution ends.
# A stop that arrives WHILE the migrate child runs is therefore acted on when the child ends (or by the platform's kill
# after stop_grace_period); the child keeps its own lock and statement bounds. Every other step stays interruptible.
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

# BEGIN owner-login runtime-db-config — a literal copy of packages/rab-server/src/database/owner-login/runtime-db-config.ts
# (readRuntimeDbConfig with requireMigrateOnStart). Messages must stay identical; runtime-db-config.spec.ts checks parity.
crewflow_runtime_db_config() {
  if [ -n "${CREWFLOW_DB_MODE:-}" ]; then
    refuse "There is no database mode switch any more: the API, the Worker and migrations all use the one PG_DATABASE_URL owner login. Remove CREWFLOW_DB_MODE. Refusing to start."
  fi
  if [ -n "${CREWFLOW_UPGRADE_FAILURE:-}" ]; then
    refuse "CREWFLOW_UPGRADE_FAILURE was removed (OWNER-DB-ULTIMATE Part B3): a failed migration always refuses to start and is retried on the next start; only a failed upgrade command serves, with upgrade:\"failed\" on /healthz. Remove it from the environment. Refusing to start."
  fi
  if [ -n "${CREWFLOW_UPGRADE_FAILURE_POLICY:-}" ]; then
    refuse "CREWFLOW_UPGRADE_FAILURE_POLICY was removed (OWNER-DB-ULTIMATE Part B3): a failed migration always refuses to start and is retried on the next start; only a failed upgrade command serves, with upgrade:\"failed\" on /healthz. Remove it from the environment. Refusing to start."
  fi
  if [ -n "${CREWFLOW_UPGRADE_INCOMPLETE:-}" ]; then
    refuse "CREWFLOW_UPGRADE_INCOMPLETE was retired (OWNER-DB-ULTIMATE Part B3): nothing sets it, and no gate accepts a pending migration any more. Remove it from the environment. Refusing to start."
  fi
  if [ "${NODE_ENV:-}" != test ]; then
    for seam in CREWFLOW_MIGRATION_TEST_STOP_BEFORE CREWFLOW_MIGRATION_TEST_FAIL_AT CREWFLOW_TEST_UPGRADE_COMMANDS CREWFLOW_TEST_UPGRADE_FAIL_COMMAND CREWFLOW_TEST_DEFER_SERVER_PROVISIONING; do
      eval "seam_value=\${$seam:-}"
      if [ -n "$seam_value" ]; then refuse "$seam is a test seam: it is allowed only with NODE_ENV=test on a disposable test database. Remove it. Refusing to start."; fi
    done
  fi
  # Owner decision C1 (2026-11-05): DISABLE_DB_MIGRATIONS=true = this process never migrates; it overrides
  # CREWFLOW_MIGRATE_ON_START, which is then not required (a present value is still validated).
  case "${DISABLE_DB_MIGRATIONS:-}" in
    true) DISABLE_MIGRATIONS=true ;;
    false | '') DISABLE_MIGRATIONS=false ;;
    *) refuse "DISABLE_DB_MIGRATIONS must be exactly one of: true, false. Refusing to start." ;;
  esac
  case "${CREWFLOW_MIGRATE_ON_START:-}" in
    true | false) MIGRATE_ON_START="$CREWFLOW_MIGRATE_ON_START" ;;
    '')
      if [ "$DISABLE_MIGRATIONS" != true ]; then
        refuse "CREWFLOW_MIGRATE_ON_START is required on the API service: set it to true (the API applies pending migrations on start, under the migration lock) or false (a release step runs them first). Refusing to start."
      fi
      MIGRATE_ON_START=false
      ;;
    *) refuse "CREWFLOW_MIGRATE_ON_START must be exactly one of: true, false. Refusing to start." ;;
  esac
  if [ "$DISABLE_MIGRATIONS" = true ]; then MIGRATE_ON_START=false; fi
  case "${CREWFLOW_MIGRATION_APPROVAL_MODE:-}" in
    none | token) APPROVAL_MODE="$CREWFLOW_MIGRATION_APPROVAL_MODE" ;;
    '') APPROVAL_MODE=none ;; # owner decision BC-11: optional, off by default everywhere (production included)
    *) refuse "CREWFLOW_MIGRATION_APPROVAL_MODE must be exactly one of: none, token. Refusing to start." ;;
  esac
}
# END owner-login runtime-db-config
crewflow_runtime_db_config

# Security review I3 (OWNER-DB-ULTIMATE Part B): CREWFLOW_APP_VERSION is baked into the image (Dockerfile ARG -> ENV). A
# runtime value that differs from the release version of the code shipped in this image (/app/package.json) is refused
# before anything runs: the upgrade logbook's version check must never run under a claimed release.
if [ -n "${CREWFLOW_APP_VERSION:-}" ] && [ -f package.json ]; then
  SHIPPED_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  if [ "$SHIPPED_VERSION" != "$CREWFLOW_APP_VERSION" ]; then
    refuse "CREWFLOW_APP_VERSION differs from this image's release version (package.json $SHIPPED_VERSION). Remove the runtime override. Refusing to start."
  fi
fi

# O3 C2: DISABLE_CRON_JOBS_REGISTRATION (Twenty's switch; exactly true or false, unset = false) and the scheduler mode the
# Worker will run (WORKER_SCHEDULER unset = bullmq in production, interval elsewhere — env.validation.ts's rule).
case "${DISABLE_CRON_JOBS_REGISTRATION:-}" in
  true) CRON_REGISTRATION=false ;;
  false | '') CRON_REGISTRATION=true ;;
  *) refuse 'DISABLE_CRON_JOBS_REGISTRATION must be exactly true or false (unset = false).' ;;
esac
case "${WORKER_SCHEDULER:-}" in
  bullmq | interval) SCHEDULER_MODE="$WORKER_SCHEDULER" ;;
  '') if [ "${NODE_ENV:-}" = production ]; then SCHEDULER_MODE=bullmq; else SCHEDULER_MODE=interval; fi ;;
  *) refuse 'WORKER_SCHEDULER must be exactly interval or bullmq (unset = bullmq in production, interval elsewhere).' ;;
esac

# Bounded backoff before a failure exit (configuration refusals exit 64 at once).
case "${CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS:-15}" in
  *[!0-9]*) refuse 'CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS must be a whole number of seconds from 0 to 300 (unset = 15).' ;;
esac
FAILURE_DELAY="${CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS:-15}"
if [ "$FAILURE_DELAY" -gt 300 ]; then refuse 'CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS must be a whole number of seconds from 0 to 300 (unset = 15).'; fi
fail_after_delay() {
  echo "api-prestart: REFUSED - $2 (exit $1)" >&2
  if [ "$FAILURE_DELAY" -gt 0 ]; then
    echo "api-prestart: waiting ${FAILURE_DELAY}s before exiting (bounded backoff; CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS)" >&2
    run_step sleep "$FAILURE_DELAY" || true
  fi
  exit "$1"
}

# The per-release approval token: only with migrate-on-start in token mode, and then only for the migrate child. It is
# removed from this shell's environment here, before the refusal loops below (which refuse it in every other case) and
# long before main.js is exec'd.
MIGRATION_APPROVAL=""
if [ "$MIGRATE_ON_START" = true ] && [ "$APPROVAL_MODE" = token ] && [ -n "${CREWFLOW_MIGRATION_APPROVED:-}" ]; then
  MIGRATION_APPROVAL="$CREWFLOW_MIGRATION_APPROVED"
  unset CREWFLOW_MIGRATION_APPROVED
fi
# The owner CLI one-off (arguments given) and ONLY it: its per-invocation command authority (DB_TARGET and
# ALLOW_PRODUCTION_DB_COMMANDS, passed with `docker compose run -e`, never in a service or env file) is taken out of this
# shell's environment before the refusal loops below (which refuse it in every other case) and handed back only to the
# one-off command, which applies its own production-command rules. The API start (no arguments) refuses both, as before.
ONEOFF_DB_TARGET=""
ONEOFF_ALLOW_PRODUCTION_DB_COMMANDS=""
if [ "$#" -gt 0 ]; then
  ONEOFF_DB_TARGET="${DB_TARGET:-}"
  ONEOFF_ALLOW_PRODUCTION_DB_COMMANDS="${ALLOW_PRODUCTION_DB_COMMANDS:-}"
  unset DB_TARGET ALLOW_PRODUCTION_DB_COMMANDS
fi

# Security review L-4: these two loops plus the owner-login loop below are a literal copy of the shared list in
# packages/rab-server/src/database/typeorm/core/never-in-runtime-env.ts (forbiddenRuntimeEnvNames('api')), which main.js
# enforces in-process as well; never-in-runtime-env.spec.ts fails the server build when they drift. Strict BY NAME here,
# DB_TARGET included: the in-process guard alone tolerates DB_TARGET=local|test in a non-production runtime (local
# `yarn start` with a developer .env), and this script only ever runs inside the image, where no compose file injects one.
for name in DATABASE_URL_UNPOOLED CREWFLOW_MIGRATION_DATABASE_URL CREWFLOW_PRESTART_MIGRATION_DATABASE_URL CREWFLOW_PROVISIONER_DATABASE_URL \
    CREWFLOW_BOOTSTRAP_PASSWORD CREWFLOW_APP_BOOTSTRAP_PASSWORD CREWFLOW_MIGRATOR_PASSWORD CREWFLOW_MIGRATION_PHASE \
    CREWFLOW_MIGRATION_APPROVED ALLOW_PRODUCTION_DB_COMMANDS DB_TARGET CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service (migration and command authority belong only to the migrate child and its per-release approval)."; fi
done
# Retired separated-mode operations variables (the removed rab-ops container's own crewflow_app URL, its marker, the operator
# label). Nothing reads them any more; any value is refused here, and pg-config.ts refuses them in every process as well.
for name in CREWFLOW_OPS_RUN PG_OPS_APP_DATABASE_URL CREWFLOW_OPS_ACTOR_SOURCE CREWFLOW_OPS_ACTOR_ID CREWFLOW_OPS_CHANGE_REF; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service (a retired separated-mode variable; never valid)."; fi
done
# Owner-login architecture: ONE database URL (PG_DATABASE_URL). Legacy and second database URLs and role passwords never
# belong here. (The removed CREWFLOW_DB_MODE is refused above by the runtime-db-config copy, with its own message.)
for name in DATABASE_URL DATABASE_DIRECT_URL PG_DATABASE_REPLICA_URL PG_WORKER_DATABASE_URL CREWFLOW_WORKER_BOOTSTRAP_PASSWORD \
    CREWFLOW_OWNER_PASSWORD CREWFLOW_OWNER_BOOTSTRAP_PASSWORD PG_DATABASE_PASSWORD; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service: the API, the Worker and the migrate child use ONE database URL, PG_DATABASE_URL (the crewflow_owner login), and no role password belongs in application configuration."; fi
done
# Name prefixes — a literal copy of forbiddenRuntimeEnvPrefixes('api'): the separate provisioner's settings never belong here.
for prefix in CREWFLOW_PROVISIONER_; do
  for forbidden in $(env | sed -n "s/^\(${prefix}[A-Za-z0-9_]*\)=..*/\1/p" | sort); do
    refuse "$forbidden must never be set on the api service: workspace provisioning runs inside the Worker on the one owner login."
  done
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

# DB-SETUP (Twenty Helm model, OWNER-DB-FINAL.md Part A): rab-api NEVER receives PG_DATABASE_URL (admin URL, crewflow_owner
# URL, anything). Only the one-shot db-setup service does; its bootstrap child creates crewflow_owner if missing (random
# password, stored in /run/crewflow/db-target/owner-password, 0400; for an existing crewflow_owner URL, that URL's
# password) and writes the CREDENTIAL-FREE target file /run/crewflow/db-target/target.json
# ({"v":1,"host","port","database","params"}: no user, no password); both are mounted read-only here. Twenty: the server
# receives only the app user's URL (helm/twenty/templates/deployment-server.yaml:142-156). This shell builds the crewflow_owner runtime URL with the pure derive step (never connects; the URL comes back on
# fd 4 through a command substitution: never a file, never argv, never the log):
#   - PG_DATABASE_URL set (non-empty) here, any login: refused (64) before anything runs. An empty value is unset.
#   - CREWFLOW_DB_TARGET_FILE=<that file> -> the URL from the target and the password file. A file that is not there yet
#     (derive exit 75) is waited for, 2 s apart, at most 120 s (60 attempts: bounded by a COUNT, never by the clock, so a
#     clock step cannot stretch or end the wait), with a fixed message, because a platform may not honour depends_on:
#     condition: service_completed_successfully (OpenShip: NOT VERIFIED); then exit 75. There is no other path. The derive
#     run is NOT wrapped in busybox `timeout`: its watcher process inherits the command-substitution pipe (fd 4) and keeps it
#     open until the bound expires, so every start paid the full bound (measured: 20 s with `timeout 20` for a step that takes
#     0 s), and a slow cold start was killed. A hang is prevented inside the step instead: both files are opened
#     O_NONBLOCK|O_NOFOLLOW and fstat-checked, so a FIFO, a symlink or a directory is refused at once (exit 64).
# Then PG_DATABASE_URL = the runtime URL; PG_DATABASE_PASSWORD and CREWFLOW_DB_TARGET_FILE are unset.
# TLS (D1 a): when the runtime URL's host is exactly `db` and PG_SSL_CA_CERT_PATH is unset (or blank), it is set to the
# bundled db's own CA (mounted read-only). The block below is identical in worker-start.sh and db-setup.sh
# (run-prestart-shell-tests.cjs compares them).
# BEGIN crewflow bundled-db CA
crewflow_bundled_db_ca() {
  db_rest="${PG_DATABASE_URL#*://}"
  db_authority="${db_rest%%[/?#]*}"
  db_hostport="${db_authority##*@}"
  db_host="${db_hostport%%:*}"
  if [ "$db_host" = db ] && [ -z "${PG_SSL_CA_CERT_PATH:-}" ]; then
    export PG_SSL_CA_CERT_PATH=/run/crewflow/db-ca/ca.crt
  fi
  unset db_rest db_authority db_hostport db_host
}
# END crewflow bundled-db CA
DERIVE_RUNTIME_URL="$SCRIPTS/owner-login/derive-runtime-url.js"
DB_TARGET_FILE=/run/crewflow/db-target/target.json
DB_SETUP_WAIT_SECONDS=120
# Test seam (NODE_ENV=test only, like the migration seams above): a shorter bound for the shell tests.
if [ -n "${CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS:-}" ]; then
  if [ "${NODE_ENV:-}" != test ]; then refuse 'CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS is a test seam: it is allowed only with NODE_ENV=test. Remove it. Refusing to start.'; fi
  case "$CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS" in ''|*[!0-9]*) refuse 'CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS must be a whole number of seconds.' ;; esac
  DB_SETUP_WAIT_SECONDS="$CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS"
fi
unset CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS
if [ -n "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL must never be set on the api service: it belongs only to the one-shot db-setup service (the admin URL, an existing crewflow_owner URL, or the bundled db). The API builds the crewflow_owner URL from the target and password files db-setup writes. Value not shown. Refusing to start.'
fi
unset PG_DATABASE_URL
export CREWFLOW_DB_TARGET_FILE="$DB_TARGET_FILE"
DB_SETUP_ATTEMPTS=$(( (DB_SETUP_WAIT_SECONDS + 1) / 2 ))
if [ "$DB_SETUP_ATTEMPTS" -lt 1 ]; then DB_SETUP_ATTEMPTS=1; fi
ATTEMPT=0
while :; do
  ATTEMPT=$((ATTEMPT + 1))
  STATUS=0
  RUNTIME_URL="$(CREWFLOW_RUNTIME_URL_FD=4 node "$DERIVE_RUNTIME_URL" 4>&1 1>&2)" || STATUS=$?
  if [ "$STATUS" -ne 75 ]; then break; fi
  RUNTIME_URL=""
  if [ "$ATTEMPT" -ge "$DB_SETUP_ATTEMPTS" ]; then
    fail_after_delay 75 "the database target file did not appear within ${DB_SETUP_WAIT_SECONDS}s: db-setup (the only service with the admin URL) has not completed"
  fi
  echo "api-prestart: waiting for db-setup: the database target file is not there yet (attempt ${ATTEMPT} of ${DB_SETUP_ATTEMPTS}, 2 s apart)"
  run_step sleep 2 || true
done
if [ "$STATUS" -ne 0 ]; then
  RUNTIME_URL=""
  fail_after_delay "$STATUS" "could not build the crewflow_owner connection (see the derive-runtime-url line above)"
fi
if [ -z "$RUNTIME_URL" ]; then
  fail_after_delay 70 'the derive step returned an empty crewflow_owner connection'
fi
export PG_DATABASE_URL="$RUNTIME_URL"
unset RUNTIME_URL PG_DATABASE_PASSWORD CREWFLOW_DB_TARGET_FILE
crewflow_bundled_db_ca
# The owner CLI one-off: no migrate child, no scheduler registration, no API; the cleaned environment only.
if [ "$#" -gt 0 ]; then
  trap - TERM INT
  echo "api-prestart: one-off command: running it as crewflow_owner (no migration, no scheduler registration, no API)"
  if [ -n "$ONEOFF_DB_TARGET" ]; then export DB_TARGET="$ONEOFF_DB_TARGET"; fi
  if [ -n "$ONEOFF_ALLOW_PRODUCTION_DB_COMMANDS" ]; then export ALLOW_PRODUCTION_DB_COMMANDS="$ONEOFF_ALLOW_PRODUCTION_DB_COMMANDS"; fi
  exec /sbin/tini -s -- "$@"
fi

# The short-lived migrate child (Agent 1). Its stdout/stderr are relayed line by line; its LAST line is
#   TWENTY_MIGRATE_RESULT {"state":...,"applied":[...],"pending":[...],"exitCode":N,"serve":...,"reason":...,
#                          "failedMigration":...,"checks":[...],"upgrade":{...,"commandFailure":{"name":...}}}
# and carries no secret. The relay (awk) prints every line and, for an exit-70 result (OWNER-DB-ULTIMATE Part B3: only an
# upgrade COMMAND failed), the loud WARNING naming the command. It VETOES (exits 66, which pipefail reports) a 70 result
# that does not say serve:true, names a fresh install (EMPTY / BOOTSTRAP-PARTIAL), names a failed migration, or names no
# failed command: a serving start is never taken on the exit code alone. Every line streams to the log on fd 3; fd 4 (the
# command substitution in run_migrate_child; NO file is written: rab-api is read_only, O3 T8a-TMP) carries only the
# relay status back to this shell.
MIGRATE_CHILD="$SCRIPTS/migrate/twenty/twenty-migrate.js"
RELAY_AWK='
function field(name,   m) {
  if (match($0, "\"" name "\":\"[^\"]*\"")) { m = substr($0, RSTART, RLENGTH); sub("^\"" name "\":\"", "", m); sub("\"$", "", m); return m }
  return ""
}
{ print; fflush() }
/^TWENTY_MIGRATE_RESULT / {
  if ($0 ~ /"exitCode":70[,}]/) {
    command = ""
    if (match($0, /"commandFailure":\{"name":"[A-Za-z0-9_.]+"/)) { command = substr($0, RSTART, RLENGTH); sub(/^"commandFailure":\{"name":"/, "", command); sub(/"$/, "", command) }
    if (length(command) > 200) command = ""
    printf "api-prestart: WARNING - an upgrade COMMAND FAILED (%s); every migration applied, so the API serves with upgrade:\"failed\" on /healthz. The next start retries it. reason=%s state=%s\n", (command == "" ? "unknown" : command), field("reason"), field("state") > "/dev/stderr"
    fflush("/dev/stderr")
    if ($0 !~ /"serve":true/ || $0 ~ /"state":"(EMPTY|BOOTSTRAP-PARTIAL)"/ || $0 !~ /"failedMigration":null[,}]/ || command == "") veto = 1
  }
}
END {
  if (veto) {
    print "api-prestart: REFUSED - the migrate child reported exit 70 that is not a verified upgrade-command failure (serve not true, a fresh install, a failed migration, or no failed command)" > "/dev/stderr"
    exit 66
  }
}
'
# run_migrate_child: fd 3 = this shell's stdout (the container log); inside the command substitution the relay's stdout is
# fd 3 (every line streams to the log as before) and its fd 4 is the substitution's pipe, which carries only the machine
# line `relay-status=<exit status of the pipeline>` (the child's code, or the relay's veto 66) back to this shell. Returns
# the status.
run_migrate_child() {
  exec 3>&1
  RELAY_CAPTURE=$(
    if [ -n "$MIGRATION_APPROVAL" ]; then
      (set -o pipefail; CREWFLOW_MIGRATION_APPROVED="$MIGRATION_APPROVAL" node "$MIGRATE_CHILD" 2>&1 | awk "$RELAY_AWK" 4>&1 1>&3)
    else
      (set -o pipefail; node "$MIGRATE_CHILD" 2>&1 | awk "$RELAY_AWK" 4>&1 1>&3)
    fi
    echo "relay-status=$?"
  )
  exec 3>&-
  STATUS=$(printf '%s\n' "$RELAY_CAPTURE" | sed -n 's/^relay-status=\([0-9][0-9]*\)$/\1/p' | tail -n 1)
  if [ -z "$STATUS" ]; then STATUS=1; fi
  return "$STATUS"
}

if [ "$MIGRATE_ON_START" = true ]; then
  attempt=1
  while :; do
    echo "api-prestart: applying pending migrations on start (CREWFLOW_MIGRATE_ON_START=true, approval=$APPROVAL_MODE, attempt $attempt of 3)"
    STATUS=0
    run_migrate_child || STATUS=$?
    if [ "$STATUS" -eq 69 ] && [ "$attempt" -lt 3 ]; then
      backoff=$((attempt * 10))
      echo "api-prestart: the migration lock is held by another instance (exit 69); retrying in ${backoff}s" >&2
      run_step sleep "$backoff" || true
      attempt=$((attempt + 1))
      continue
    fi
    break
  done
  case "$STATUS" in
    0) echo "api-prestart: the schema is current for this code" ;;
    70)
      # OWNER-DB-ULTIMATE Part B3: verified by the relay (a failed upgrade COMMAND, no failed migration, not a fresh install).
      echo "api-prestart: WARNING - an upgrade command failed; every migration is applied, so the API serves with upgrade:\"failed\" on /healthz and the admin banner. Fix the command and restart (it is retried; see the WARNING and TWENTY_MIGRATE_RESULT lines above)." >&2
      ;;
    64) fail_after_delay 64 "the migrate child refused its configuration" ;;
    65) fail_after_delay 65 "the schema is behind this code" ;;
    66) fail_after_delay 66 "a migration failed: the API does not start (OWNER-DB-ULTIMATE Part B3); the next start retries it" ;;
    67) fail_after_delay 67 "the deployment identity check failed" ;;
    68) fail_after_delay 68 "a post-migration check failed" ;;
    69) fail_after_delay 69 "the migration lock was not acquired after 3 attempts" ;;
    *) fail_after_delay "$STATUS" "the migrate child failed" ;;
  esac
else
  if [ "$DISABLE_MIGRATIONS" = true ]; then
    echo "api-prestart: DISABLE_DB_MIGRATIONS=true - this process never migrates; checking the schema is current (read-only)"
  else
    echo "api-prestart: checking the schema is current (read-only; CREWFLOW_MIGRATE_ON_START=false)"
  fi
  STATUS=0
  run_step node "$SCRIPTS/check-pending-migrations.js" || STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    fail_after_delay 65 "the schema is behind this code (or the database login is wrong). Run the release migration step for this release first, or set CREWFLOW_MIGRATE_ON_START=true (and DISABLE_DB_MIGRATIONS unset or false)"
  fi
fi

# O3 C2 — job scheduler registration, like Twenty's entrypoint: after the migrate step, before main.js. Idempotent (fixed
# ids); a failure is tolerated with a loud WARNING (owner decision 2026-11-05) — the API still starts, and the consume-only
# Worker's read-only verify reports the missing schedulers as an ERROR (and turns unhealthy) until a later start registers them.
if [ "$CRON_REGISTRATION" != true ]; then
  echo "api-prestart: DISABLE_CRON_JOBS_REGISTRATION=true - job schedulers are not registered by this start"
elif [ "$SCHEDULER_MODE" != bullmq ]; then
  echo "api-prestart: WORKER_SCHEDULER=interval - each Worker runs its own timers; no job schedulers to register"
else
  echo "api-prestart: registering the job schedulers (DISABLE_CRON_JOBS_REGISTRATION unset; idempotent, fixed ids)"
  STATUS=0
  run_step node packages/rab-worker/dist/register-schedulers.js || STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    echo "api-prestart: WARNING job scheduler registration FAILED (exit $STATUS) - starting the API anyway; scheduled scans do not run until a later API start registers them (the Worker reports the missing schedulers as an ERROR)" >&2
  fi
fi

# PID 1 hand-over: tini replaces this shell as PID 1 with the cleaned environment and runs main.js as its child.
trap - TERM INT
exec /sbin/tini -s -- node packages/rab-server/dist/main.js
