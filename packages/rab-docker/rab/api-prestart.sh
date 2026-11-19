#!/bin/sh
# API start: rab-api's ENTRYPOINT in every deploy compose file (DB-SETUP; also the image's default command). Runs from /app
# (the image WORKDIR).
#
# DATABASE (owner decision 2026-11-18, "change PR #125 option 2 to Twenty's way"): this container reads PG_DATABASE_URL, the
# crewflow_owner URL, straight from its environment, like Twenty's server (twentyhq/twenty@eedb0a73
# packages/twenty-docker/helm/twenty/templates/deployment-server.yaml:148-155). There is no target file, no password file and
# no derive step any more. This script is PID 1 (compose `entrypoint: ["./api-prestart.sh"]`, no compose init); it refuses
# an empty PG_DATABASE_URL or one with an empty password, every OTHER database URL or credential (PG_ADMIN_URL above all: the
# admin login belongs only to the one-shot db-setup service), then execs the init: `exec /sbin/tini -s -- node
# packages/rab-server/dist/main.js`. Run with arguments (the owner CLI one-off: `docker compose run --rm --no-deps rab-api
# node packages/rab-server/dist/command/main.js <command>`), it does the same refusals with the same PG_DATABASE_URL, then
# `exec /sbin/tini -s -- "$@"`: nothing migrates or registers. A wrong login (not crewflow_owner), a transaction-pooler host,
# or a SUPERUSER / BYPASSRLS / CREATEDB / REPLICATION / (after the bootstrap, unmarked) CREATEROLE login is refused by the
# processes themselves (runtime-db-config.ts checkRuntimeLogin before connecting; the boot gates once connected).
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
#   2b. requires PG_DATABASE_URL (the crewflow_owner URL; exit 64 when it is empty, its password is empty, or its login is not
#      crewflow_owner by a pure userinfo parse: security review of PR #246, L2) and points PG_SSL_CA_CERT_PATH at the
#      bundled db's CA when its host is `db` (details below);
#   3. CREWFLOW_MIGRATE_ON_START=true (and DISABLE_DB_MIGRATIONS not true): runs the short-lived migrate child (Agent 1:
#      migration lock, fresh-install classifier, post-checks, the upgrade logbook). Exit 0 = current / applied / ledger
#      ahead; 70 = every migration applied but an upgrade COMMAND failed (OWNER-DB-ULTIMATE Part B3: serve, loud WARNING,
#      /healthz upgradeFailed:true); 66 = a migration failed (never serves; the next start retries it);
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
# The Worker never runs this, and never migrates: its entrypoint is worker-start.sh (the same refusals, never the admin).
set -eu

SCRIPTS=packages/rab-server/dist/database/typeorm/scripts

refuse() {
  echo "api-prestart: REFUSED - $1" >&2
  exit 64
}

# BEGIN crewflow database-URL refusal
# Security review of PR #230, L-1 (+ follow-up): the names of every variable that holds a database credential in a form the
# app or libpq would accept: a postgres URL (any case, after leading blanks or quotes, with a driver prefix or suffix such as
# jdbc:postgresql:// or postgresql+psycopg://), or a libpq keyword DSN with a password (password=... beside host= / hostaddr=
# / dbname= / user=). The caller's own PG_DATABASE_URL is left out (it has its own refusal). Names only, never a value. The
# block is identical in api-prestart.sh and worker-start.sh (run-prestart-shell-tests.cjs compares them).
crewflow_db_url_names() {
  crewflow_re_url="^[A-Za-z_][A-Za-z0-9_]*=[[:space:]\"']*([a-z]+:)?postgres(ql)?(\\+[A-Za-z0-9]+)?://"
  crewflow_re_pw="^[A-Za-z_][A-Za-z0-9_]*=(.*[[:space:]\"'])?password[[:space:]]*="
  crewflow_re_kw="(^|[[:space:]\"'=])(host|hostaddr|dbname|user)[[:space:]]*="
  {
    env | grep -iE "$crewflow_re_url"
    env | grep -iE "$crewflow_re_pw" | grep -iE "$crewflow_re_kw"
  } | grep -v '^PG_DATABASE_URL=' | cut -d= -f1 | sort -u
  unset crewflow_re_url crewflow_re_pw crewflow_re_kw
}
# END crewflow database-URL refusal

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
    refuse "CREWFLOW_UPGRADE_FAILURE was removed (OWNER-DB-ULTIMATE Part B3): a failed migration always refuses to start and is retried on the next start; only a failed upgrade command serves, with upgradeFailed:true on /healthz. Remove it from the environment. Refusing to start."
  fi
  if [ -n "${CREWFLOW_UPGRADE_FAILURE_POLICY:-}" ]; then
    refuse "CREWFLOW_UPGRADE_FAILURE_POLICY was removed (OWNER-DB-ULTIMATE Part B3): a failed migration always refuses to start and is retried on the next start; only a failed upgrade command serves, with upgradeFailed:true on /healthz. Remove it from the environment. Refusing to start."
  fi
  if [ -n "${CREWFLOW_UPGRADE_INCOMPLETE:-}" ]; then
    refuse "CREWFLOW_UPGRADE_INCOMPLETE was retired (OWNER-DB-ULTIMATE Part B3): nothing sets it, and no gate accepts a pending migration any more. Remove it from the environment. Refusing to start."
  fi
  if [ "${NODE_ENV:-}" != test ]; then
    for seam in CREWFLOW_MIGRATION_TEST_STOP_BEFORE CREWFLOW_MIGRATION_TEST_FAIL_AT CREWFLOW_TEST_UPGRADE_COMMANDS CREWFLOW_TEST_UPGRADE_FAIL_COMMAND CREWFLOW_TEST_DEFER_SERVER_PROVISIONING CREWFLOW_TEST_SEARCH_PATH_TRAP; do
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
if [ -n "${CREWFLOW_APP_VERSION:-}" ]; then
  # Review R3: fail closed when there is no package.json to verify the value against.
  if [ ! -f package.json ]; then
    refuse "CREWFLOW_APP_VERSION is set but this image has no /app/package.json to verify it against. Remove the runtime override. Refusing to start."
  fi
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
    CREWFLOW_OWNER_PASSWORD CREWFLOW_OWNER_BOOTSTRAP_PASSWORD PG_DATABASE_PASSWORD PG_DATABASE_APP_PASSWORD; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service: the API, the Worker and the migrate child use ONE database URL, PG_DATABASE_URL (the crewflow_owner login), and no role password belongs in application configuration (compose interpolates PG_DATABASE_APP_PASSWORD into PG_DATABASE_URL; it never passes it on)."; fi
done
# PG_ADMIN_URL (owner decisions 2026-11-17 and 2026-11-18, Twenty's model): the database admin URL belongs ONLY to the
# one-shot db-setup service; the API never receives it, in any form (not even unused: /proc/<pid>/environ). The same for its retired name
# (PG_DATABASE_ADMIN_URL) and for db-setup's bundled-db URL (CREWFLOW_BUNDLED_DB_ADMIN_URL). The compose files pin
# PG_ADMIN_URL to "" on this service (owner decision L-2): empty is allowed, any value is refused.
for name in PG_ADMIN_URL PG_DATABASE_ADMIN_URL CREWFLOW_BUNDLED_DB_ADMIN_URL; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service: it is the database admin URL, read only by the one-shot db-setup service (which creates crewflow_owner). The API connects only as crewflow_owner. Value not shown."; fi
done
# First platform administrator at boot (2026-11-19): the API reads BOOTSTRAP_ADMIN_EMAIL and the optional
# BOOTSTRAP_ADMIN_FIRST_NAME / _LAST_NAME / _ORG_SLUG / _ORG_NAME (allowed here). There is NO bootstrap password: the
# administrator is created without one and activates through an emailed, expiring link. A password variable is refused on
# the API start AND on the one-off CLI form (the bootstrap-admin command never reads it either).
for name in BOOTSTRAP_ADMIN_PASSWORD; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service: the first platform administrator is created without a password and activates through an emailed, expiring link. Remove it. Value not shown."; fi
done
# Security review of PR #230, L-1: an admin URL under ANY other name. No variable of the API but its own PG_DATABASE_URL may
# hold a PostgreSQL URL: every other name whose value starts with postgres:// or postgresql:// (any case) is refused. Names
# only; the value is never printed.
for forbidden in $(crewflow_db_url_names); do
  refuse "$forbidden holds a PostgreSQL URL or a libpq password DSN: no database credential ever reaches the api service (the api service holds exactly one, PG_DATABASE_URL, the crewflow_owner URL; an admin URL belongs to db-setup's PG_ADMIN_URL only). Value not shown."
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

# DATABASE (owner decision 2026-11-18, Twenty's way): PG_DATABASE_URL is the crewflow_owner URL, from the environment. The
# compose files give rab-api, rab-worker and db-setup the SAME expression: your crewflow_owner URL (modes b and c), or for the
# bundled db (mode a) postgresql://crewflow_owner:<PG_DATABASE_APP_PASSWORD>@db:5432/crewflow?sslmode=verify-full, so what
# db-setup created or checked is exactly what this process uses. Refused here (exit 64, value never shown): an empty
# PG_DATABASE_URL, and an empty crewflow_owner password in it (PG_DATABASE_APP_PASSWORD unset for the bundled db). Its login,
# its host shape and its role attributes are refused by the processes (checkRuntimeLogin; the boot gates).
# TLS (D1 a): when the URL's host is exactly `db` and PG_SSL_CA_CERT_PATH and PG_SSL_CA_CERT are both unset (or blank),
# PG_SSL_CA_CERT_PATH is set to the bundled db's own CA (mounted read-only). The block below is identical in
# worker-start.sh and db-setup.sh (run-prestart-shell-tests.cjs compares them).
# BEGIN crewflow bundled-db CA
# $1: the database URL this process connects with (db-setup: PG_ADMIN_URL or PG_DATABASE_URL; rab-api / rab-worker:
# PG_DATABASE_URL, the crewflow_owner URL). Only its host is read.
crewflow_bundled_db_ca() {
  db_rest="${1#*://}"
  db_authority="${db_rest%%[/?#]*}"
  db_hostport="${db_authority##*@}"
  db_host="${db_hostport%%:*}"
  if [ "$db_host" = db ] && [ -z "${PG_SSL_CA_CERT_PATH:-}" ] && [ -z "${PG_SSL_CA_CERT:-}" ]; then
    export PG_SSL_CA_CERT_PATH=/run/crewflow/db-ca/ca.crt
  fi
  unset db_rest db_authority db_hostport db_host
}
# END crewflow bundled-db CA
if [ -z "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL is empty: it is the crewflow_owner URL (bundled db: set PG_DATABASE_APP_PASSWORD, openssl rand -hex 32; your own database: your crewflow_owner URL, direct host, sslmode=verify-full). Refusing to start.'
fi
case "$PG_DATABASE_URL" in
  *://crewflow_owner:@*)
    refuse 'PG_DATABASE_URL has an empty crewflow_owner password: for the bundled db set PG_DATABASE_APP_PASSWORD (openssl rand -hex 32); with your own database put the crewflow_owner password in PG_DATABASE_URL. Value not shown. Refusing to start.' ;;
esac
# BEGIN crewflow owner-login check
# Security review of PR #246, L2: a pure userinfo parse of a database URL ($1), before any node process runs. Returns 0 only
# when the URL's login is crewflow_owner (or its percent-encoded underscore form, crewflow%5Fowner / crewflow%5fowner); a URL
# without userinfo is not crewflow_owner. Never connects, never prints or keeps the value. The block is identical in
# api-prestart.sh, worker-start.sh and db-setup.sh (run-prestart-shell-tests.cjs compares them).
crewflow_is_owner_login() {
  ol_rest="${1#*://}"
  ol_authority="${ol_rest%%[/?#]*}"
  case "$ol_authority" in
    *@*)
      ol_login="${ol_authority%@*}"
      ol_login="${ol_login%%:*}"
      ;;
    *) ol_login='' ;;
  esac
  case "$ol_login" in
    crewflow_owner | crewflow%5Fowner | crewflow%5fowner) ol_rc=0 ;;
    *) ol_rc=1 ;;
  esac
  unset ol_rest ol_authority ol_login
  if [ "$ol_rc" = 0 ]; then
    unset ol_rc
    return 0
  fi
  unset ol_rc
  return 1
}
# END crewflow owner-login check
if ! crewflow_is_owner_login "$PG_DATABASE_URL"; then
  refuse 'PG_DATABASE_URL does not log in as crewflow_owner: it is always the crewflow_owner URL. An admin URL belongs only in PG_ADMIN_URL of db-setup (a compose.env from before 2026-11-18 had the admin URL in PG_DATABASE_URL: move it to PG_ADMIN_URL and put the crewflow_owner URL in PG_DATABASE_URL). Value not shown. Refusing to start.'
fi
export PG_DATABASE_URL
crewflow_bundled_db_ca "$PG_DATABASE_URL"
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
    printf "api-prestart: WARNING - an upgrade COMMAND FAILED (%s); every migration applied, so the API serves with upgradeFailed:true on /healthz. The next start retries it. reason=%s state=%s\n", (command == "" ? "unknown" : command), field("reason"), field("state") > "/dev/stderr"
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
      echo "api-prestart: WARNING - an upgrade command failed; every migration is applied, so the API serves with upgradeFailed:true on /healthz and the admin banner. Fix the command and restart (it is retried; see the WARNING and TWENTY_MIGRATE_RESULT lines above)." >&2
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
