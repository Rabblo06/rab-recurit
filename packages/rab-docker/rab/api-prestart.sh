#!/bin/sh
# API start (the image's default command). Runs from /app (the image WORKDIR).
#
# Owner-login architecture (owner's FINAL decision 2026-11-04; M0 §7): the API, the Worker and the migrate child all use the
# ONE database URL, PG_DATABASE_URL (the schema-owning crewflow_owner login). This script:
#   1. validates the database start-up settings — a literal copy of database/owner-login/runtime-db-config.ts between the
#      BEGIN/END markers below (runtime-db-config.spec.ts runs this copy against the TypeScript parser and fails on drift):
#      DISABLE_DB_MIGRATIONS (true | false; true = this process never migrates — O3 C1), CREWFLOW_MIGRATE_ON_START is
#      REQUIRED here (true | false) unless DISABLE_DB_MIGRATIONS=true, CREWFLOW_MIGRATION_APPROVAL_MODE (none | token),
#      CREWFLOW_UPGRADE_FAILURE (continue | refuse, default continue — O3 C3; the deprecated CREWFLOW_UPGRADE_FAILURE_POLICY
#      maps refuse -> refuse, continue-if-compatible -> continue and must agree); the removed CREWFLOW_DB_MODE is refused
#      (exit 64). CREWFLOW_UPGRADE_INCOMPLETE is set ONLY by this script: an inherited value is refused (exit 64);
#   2. refuses to start when a second database URL, a role password, migration/command authority or an operations variable
#      reached the API's environment (exit 64). The one exception is the per-release approval token
#      (CREWFLOW_MIGRATION_APPROVED) when CREWFLOW_MIGRATE_ON_START=true AND CREWFLOW_MIGRATION_APPROVAL_MODE=token: it is
#      taken out of this shell's environment first, handed ONLY to the short-lived migrate child, and never reaches main.js;
#   3. CREWFLOW_MIGRATE_ON_START=true (and DISABLE_DB_MIGRATIONS not true): runs the short-lived migrate child (Agent 1:
#      migration lock, fresh-install classifier, post-checks, upgrade-failure policy). Exit 0 = current / applied / ledger
#      ahead; 70 = an UPGRADE migration FAILED and CREWFLOW_UPGRADE_FAILURE=continue (degraded start, loud ERROR/WARNING);
#      69 = migration lock timeout (retried with bounded backoff); anything else = no start.
#      Otherwise (CREWFLOW_MIGRATE_ON_START=false, or DISABLE_DB_MIGRATIONS=true): the read-only pending-migration check
#      (exit 65 when the schema is behind);
#   4. O3 C2 (like Twenty's entrypoint): unless DISABLE_CRON_JOBS_REGISTRATION=true, registers every scan's BullMQ job
#      scheduler (one-shot packages/rab-worker/dist/register-schedulers.js: fixed ids, idempotent). A registration failure is
#      a loud WARNING and the API starts anyway; the consume-only Worker reports any missing scheduler as an ERROR;
#   5. execs main.js ONLY after exit 0 or a verified 70 (main.js runs its own boot gates as well), and after a verified 70
#      with CREWFLOW_UPGRADE_INCOMPLETE=<the failed migration, or unknown> (the API's boot gate then accepts exactly that
#      first pending migration; /healthz reports upgradeFailed: true, never the name). A fresh-install failure never serves: the child never
#      reports 70 for one, and the relay below vetoes a 70 result that names one.
# Every failure other than a configuration refusal waits CREWFLOW_STARTUP_FAILURE_DELAY_SECONDS (default 15, 0-300) before
# exiting, so a restart policy cannot turn a broken release into a tight restart storm against the database.
# The Worker never runs this, and never migrates.
set -eu

SCRIPTS=packages/rab-server/dist/database/typeorm/scripts

refuse() {
  echo "api-prestart: REFUSED - $1" >&2
  exit 64
}

# Signal handling while this shell is PID 1: a stop during a step terminates the child and exits.
# O3 T8a-TMP trade-off (stated, not silent): the migrate child's output is captured by a command substitution (no file is
# ever written: rab-api runs read_only with no tmpfs), and a POSIX shell runs a trap only after a command substitution ends.
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
  if [ "${NODE_ENV:-}" != test ]; then
    for seam in CREWFLOW_MIGRATION_TEST_STOP_BEFORE CREWFLOW_MIGRATION_TEST_FAIL_AT CREWFLOW_TEST_DEFER_SERVER_PROVISIONING; do
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
  # Owner decision C3 (2026-11-05): CREWFLOW_UPGRADE_FAILURE continue (default) | refuse; CREWFLOW_UPGRADE_FAILURE_POLICY is
  # a deprecated alias (refuse -> refuse, continue-if-compatible -> continue); the two must agree when both are set.
  case "${CREWFLOW_UPGRADE_FAILURE:-}" in
    continue | refuse) UPGRADE_POLICY="$CREWFLOW_UPGRADE_FAILURE" ;;
    '') UPGRADE_POLICY="" ;;
    *) refuse "CREWFLOW_UPGRADE_FAILURE must be exactly one of: continue, refuse. Refusing to start." ;;
  esac
  case "${CREWFLOW_UPGRADE_FAILURE_POLICY:-}" in
    refuse) UPGRADE_ALIAS=refuse ;;
    continue-if-compatible) UPGRADE_ALIAS=continue ;;
    '') UPGRADE_ALIAS="" ;;
    *) refuse "CREWFLOW_UPGRADE_FAILURE_POLICY is deprecated and must be exactly one of: refuse, continue-if-compatible; use CREWFLOW_UPGRADE_FAILURE=continue|refuse instead. Refusing to start." ;;
  esac
  if [ -n "$UPGRADE_POLICY" ] && [ -n "$UPGRADE_ALIAS" ] && [ "$UPGRADE_POLICY" != "$UPGRADE_ALIAS" ]; then
    refuse "CREWFLOW_UPGRADE_FAILURE and the deprecated CREWFLOW_UPGRADE_FAILURE_POLICY disagree; remove CREWFLOW_UPGRADE_FAILURE_POLICY. Refusing to start."
  fi
  if [ -z "$UPGRADE_POLICY" ]; then UPGRADE_POLICY="${UPGRADE_ALIAS:-continue}"; fi
}
# END owner-login runtime-db-config
crewflow_runtime_db_config

# O3 C3: CREWFLOW_UPGRADE_INCOMPLETE tells main.js (API boot gate 7, /healthz) that THIS start follows a failed upgrade. Only
# this script sets it, after a verified exit 70 below; a value that reached the container from outside could relax the API's
# pending-migration gate without any failure having happened, so it is refused, never silently overridden.
if [ -n "${CREWFLOW_UPGRADE_INCOMPLETE:-}" ]; then
  refuse "CREWFLOW_UPGRADE_INCOMPLETE must never be set on the api service: api-prestart.sh sets it itself, only after a failed upgrade under CREWFLOW_UPGRADE_FAILURE=continue. Remove it."
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
# Phase B (ops): the one-off operations container's variables (its own crewflow_app URL, its marker, the operator label) belong
# to `docker compose --profile ops run --rm rab-ops ...` only. pg-config.ts refuses them in the API process as well.
for name in CREWFLOW_OPS_RUN PG_OPS_APP_DATABASE_URL CREWFLOW_OPS_ACTOR_SOURCE CREWFLOW_OPS_ACTOR_ID CREWFLOW_OPS_CHANGE_REF; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the api service (it belongs to the one-off ops container only)."; fi
done
# Owner-login architecture: ONE database URL (PG_DATABASE_URL). Legacy and second database URLs and role passwords never
# belong here. (The removed CREWFLOW_DB_MODE is refused above by the runtime-db-config copy, with its own message.)
for name in DATABASE_URL DATABASE_DIRECT_URL PG_DATABASE_REPLICA_URL PG_WORKER_DATABASE_URL CREWFLOW_WORKER_BOOTSTRAP_PASSWORD \
    CREWFLOW_OWNER_PASSWORD CREWFLOW_OWNER_BOOTSTRAP_PASSWORD; do
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

# The short-lived migrate child (Agent 1). Its stdout/stderr are relayed line by line; its LAST line is
#   TWENTY_MIGRATE_RESULT {"state":...,"applied":[...],"pending":[...],"exitCode":N,"serve":...,"policy":...,"reason":...,
#                          "failedMigration":...,"checks":[...]}
# and carries no secret. The relay (awk) prints every line and, for an exit-70 result, the loud WARNING naming the reason and
# the failing migration. It VETOES (exits 66, which pipefail reports) a 70 result that does not say serve:true, names a
# fresh install (EMPTY / BOOTSTRAP-PARTIAL) or another policy than "continue": a degraded start is never taken on the exit
# code alone. For a verified 70 it hands the result's failedMigration back to this shell on fd 4 (the command substitution
# in run_migrate_child; NO file is written: rab-api is read_only with no tmpfs, O3 T8a-TMP) while every line still streams
# to the log on fd 3. The shell accepts it only as a plain migration name (letters, digits, _ - ., at most 200 characters;
# anything else -> "unknown") and passes it to main.js as CREWFLOW_UPGRADE_INCOMPLETE.
MIGRATE_CHILD="$SCRIPTS/migrate/twenty/twenty-migrate.js"
RELAY_AWK='
function field(name,   m) {
  if (match($0, "\"" name "\":\"[^\"]*\"")) { m = substr($0, RSTART, RLENGTH); sub("^\"" name "\":\"", "", m); sub("\"$", "", m); return m }
  return ""
}
{ print; fflush() }
/^TWENTY_MIGRATE_RESULT / {
  if ($0 ~ /"exitCode":70[,}]/) {
    failing = field("failedMigration")
    if (failing !~ /^[A-Za-z0-9_.-]+$/ || length(failing) > 200) failing = "unknown"
    printf "api-prestart: WARNING DEGRADED START - the schema upgrade FAILED and CREWFLOW_UPGRADE_FAILURE=continue; serving on the previous schema. reason=%s failing_migration=%s state=%s\n", field("reason"), failing, field("state") > "/dev/stderr"
    fflush("/dev/stderr")
    if ($0 !~ /"serve":true/ || $0 ~ /"state":"(EMPTY|BOOTSTRAP-PARTIAL)"/ || $0 !~ /"policy":"continue"[,}]/) veto = 1
    else { printf "failed-migration=%s\n", failing > "/dev/fd/4"; close("/dev/fd/4") }
  }
}
END {
  if (veto) {
    print "api-prestart: REFUSED - the migrate child reported a degraded continue (70) that is not a verified continue upgrade (serve not true, a fresh install, or another policy)" > "/dev/stderr"
    exit 66
  }
}
'
# run_migrate_child: fd 3 = this shell's stdout (the container log); inside the command substitution the relay's stdout is
# fd 3 (every line streams to the log as before) and its fd 4 is the substitution's pipe, which carries only two
# machine lines back to this shell: `failed-migration=<name>` (a verified 70) and `relay-status=<exit status of the
# pipeline>` (the child's code, or the relay's veto 66). Sets FAILED_MIGRATION; returns the status.
FAILED_MIGRATION=""
run_migrate_child() {
  FAILED_MIGRATION=""
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
  FAILED_MIGRATION=$(printf '%s\n' "$RELAY_CAPTURE" | sed -n 's/^failed-migration=//p' | tail -n 1)
  if [ -z "$STATUS" ]; then STATUS=1; fi
  return "$STATUS"
}

UPGRADE_INCOMPLETE=""
if [ "$MIGRATE_ON_START" = true ]; then
  attempt=1
  while :; do
    echo "api-prestart: applying pending migrations on start (CREWFLOW_MIGRATE_ON_START=true, approval=$APPROVAL_MODE, CREWFLOW_UPGRADE_FAILURE=$UPGRADE_POLICY, attempt $attempt of 3)"
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
      if [ "$UPGRADE_POLICY" != continue ]; then
        fail_after_delay 66 "the migrate child reported a degraded continue (70) but CREWFLOW_UPGRADE_FAILURE is not continue"
      fi
      # The relay's failedMigration, re-validated here: a plain migration name of at most 200 characters, else unknown (which
      # the API's gate 7 then refuses: fail closed).
      UPGRADE_INCOMPLETE="$FAILED_MIGRATION"
      case "$UPGRADE_INCOMPLETE" in
        '' | *[!A-Za-z0-9_.-]*) UPGRADE_INCOMPLETE=unknown ;;
      esac
      if [ "${#UPGRADE_INCOMPLETE}" -gt 200 ]; then UPGRADE_INCOMPLETE=unknown; fi
      echo "api-prestart: WARNING DEGRADED START - the upgrade FAILED at $UPGRADE_INCOMPLETE and CREWFLOW_UPGRADE_FAILURE=continue: the API serves on the previous schema (see the WARNING and TWENTY_MIGRATE_RESULT lines above; /healthz reports upgradeFailed: true). Fix the failing migration and redeploy. The Worker starts as well, on the partly-upgraded schema (owner decision 2026-11-05)." >&2
      ;;
    64) fail_after_delay 64 "the migrate child refused its configuration" ;;
    65) fail_after_delay 65 "the schema is behind this code" ;;
    66) fail_after_delay 66 "a migration failed (a fresh install never serves; an upgrade serves only with CREWFLOW_UPGRADE_FAILURE=continue and a verified result)" ;;
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

trap - TERM INT
if [ -n "$UPGRADE_INCOMPLETE" ]; then
  CREWFLOW_UPGRADE_INCOMPLETE="$UPGRADE_INCOMPLETE" exec node packages/rab-server/dist/main.js
fi
exec node packages/rab-server/dist/main.js
