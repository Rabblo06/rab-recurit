#!/bin/sh
# Worker start: rab-worker's ENTRYPOINT in every deploy compose file (["./worker-start.sh"], no compose init). Runs from
# /app (the image WORKDIR) as PID 1, then execs the image's tini: `exec /sbin/tini -s -- node packages/rab-worker/dist/main.js`.
# tini becomes PID 1 (signal forwarding, zombie reaping) and the Worker its child, so the Worker's watchdog SIGKILL (ignored
# by the kernel for PID 1) still works without compose's `init: true`.
#
# PR #125 option 2 (owner decision 2026-11-13): this container NEVER receives PG_DATABASE_URL, in any form; only the
# one-shot db-setup service does. This script:
#   1. refuses arguments, PG_DATABASE_PASSWORD and a non-empty PG_DATABASE_URL (any login; exit 64);
#   2. builds the crewflow_owner runtime URL with the same pure derive step as api-prestart.sh (never connects; the URL
#      comes back on fd 4 through a command substitution: never a file, never argv, never the log), from db-setup's
#      credential-free target file (CREWFLOW_DB_TARGET_FILE=/run/crewflow/db-target/target.json) and the crewflow_owner
#      password file beside it (both mounted read-only; Twenty: the worker receives only the app user's URL,
#      helm/twenty/templates/deployment-worker.yaml:76-90), waiting for both (derive exit 75) 2 s apart, at most 120 s;
#   3. sets PG_SSL_CA_CERT_PATH to the bundled db's CA when the runtime URL's host is exactly `db` and it is unset (the block
#      below is identical in api-prestart.sh and db-setup.sh; run-prestart-shell-tests.cjs compares them);
#   4. exports the runtime URL as PG_DATABASE_URL and execs tini. The Worker itself retries a 28P01 first login (its
#      password not set yet by db-setup) for up to 120 s (core/runtime/owner-password-wait.ts), and refuses, in production,
#      any PG_DATABASE_URL that does not log in as crewflow_owner before connecting (runtime-db-config.ts checkRuntimeLogin).
# Exit 64 = refusal (fixed message), 70 = unexpected, 75 = db-setup did not complete in time. Never prints a URL, a
# password, a host or a database name.
set -eu

refuse() {
  echo "worker-start: REFUSED - $1" >&2
  exit "${2:-64}"
}

if [ "$#" -ne 0 ]; then
  refuse 'worker-start.sh takes no arguments (it starts the Worker only; one-off commands run from rab-api).'
fi
if [ -n "${PG_DATABASE_PASSWORD:-}" ]; then
  refuse 'PG_DATABASE_PASSWORD must never be set on the worker service: only compose reads it (the bundled db and the default admin URL); the Worker connects only as crewflow_owner.'
fi

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

DERIVE_RUNTIME_URL=packages/rab-server/dist/database/typeorm/scripts/owner-login/derive-runtime-url.js
DB_TARGET_FILE=/run/crewflow/db-target/target.json
WAIT_SECONDS=120
# Test seam (NODE_ENV=test only, as in api-prestart.sh): a shorter bound for the shell tests.
if [ -n "${CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS:-}" ]; then
  if [ "${NODE_ENV:-}" != test ]; then refuse 'CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS is a test seam: it is allowed only with NODE_ENV=test. Remove it.'; fi
  case "$CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS" in ''|*[!0-9]*) refuse 'CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS must be a whole number of seconds.' ;; esac
  WAIT_SECONDS="$CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS"
fi
unset CREWFLOW_TEST_DB_SETUP_WAIT_SECONDS
if [ -n "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL must never be set on the worker service: it belongs only to the one-shot db-setup service (the admin URL, an existing crewflow_owner URL, or the bundled db). The Worker builds the crewflow_owner URL from the target and password files db-setup writes. Value not shown.'
fi
unset PG_DATABASE_URL
export CREWFLOW_DB_TARGET_FILE="$DB_TARGET_FILE"
STARTED="$(date +%s)"
while :; do
  STATUS=0
  RUNTIME_URL="$(node "$DERIVE_RUNTIME_URL" 4>&1 1>&2)" || STATUS=$?
  if [ "$STATUS" -ne 75 ]; then break; fi
  RUNTIME_URL=""
  WAITED=$(( $(date +%s) - STARTED ))
  if [ "$WAITED" -ge "$WAIT_SECONDS" ]; then
    refuse "the database target file did not appear within ${WAIT_SECONDS}s: db-setup (the only service with the admin URL) has not completed." 75
  fi
  echo "worker-start: waiting for db-setup: the database target file is not there yet (${WAITED}s of ${WAIT_SECONDS}s)" >&2
  sleep 2
done
if [ "$STATUS" -ne 0 ]; then
  RUNTIME_URL=""
  refuse 'could not build the crewflow_owner connection (see the derive-runtime-url line above).' "$STATUS"
fi
if [ -z "$RUNTIME_URL" ]; then
  refuse 'the derive step returned an empty crewflow_owner connection.' 70
fi
export PG_DATABASE_URL="$RUNTIME_URL"
unset RUNTIME_URL PG_DATABASE_PASSWORD CREWFLOW_DB_TARGET_FILE
crewflow_bundled_db_ca
exec /sbin/tini -s -- node packages/rab-worker/dist/main.js
