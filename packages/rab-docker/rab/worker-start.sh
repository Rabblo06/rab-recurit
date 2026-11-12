#!/bin/sh
# Worker start: rab-worker's ENTRYPOINT in every deploy compose file (["./worker-start.sh"], no compose init). Runs from
# /app (the image WORKDIR) as PID 1.
#
# PID 1 (DB-SETUP, lead decision 2026-11-12, owner requirement #5): a container's environment is its PID 1's environment and
# stays readable in /proc/1/environ to every process of the same uid. So this script is PID 1, cleans its environment, and
# only then execs the init: `exec /sbin/tini -s -- node packages/rab-worker/dist/main.js`. tini becomes PID 1 (signal
# forwarding, zombie reaping) and the Worker its child, so the Worker's watchdog SIGKILL (ignored by the kernel for PID 1)
# still works without compose's `init: true` (which would put docker-init, with the admin URL, at PID 1).
#
# DB-SETUP (database setup like Twenty; DB-SETUP-PLAN §5.3, owner decisions D1 a / D5). The container's PG_DATABASE_URL is
# the database ADMIN URL (or an existing crewflow_owner URL, passed through unchanged). The Worker NEVER connects as the
# admin and never runs the bootstrap child (rab-api does, and the Worker starts only after a healthy rab-api):
#   1. refuses PG_DATABASE_PASSWORD (only compose reads it, for the bundled db; exit 64);
#   2. sets PG_SSL_CA_CERT_PATH to the bundled db's CA when the URL's host is exactly `db` and it is unset (the block below
#      is identical in api-prestart.sh; run-prestart-shell-tests.cjs compares the two);
#   3. derives the crewflow_owner runtime URL with the SAME pure step as api-prestart.sh (derive-runtime-url.js, fd 4 through
#      a command substitution: never a file, never argv, never the log), so both build byte-identical URLs;
#   4. replaces PG_DATABASE_URL with it, unsets every admin credential, then execs tini, which runs the Worker. exec makes
#      the kernel's view of tini and of the Worker (/proc/<pid>/environ) exactly the exported environment: the admin URL is
#      in no process of the container once the Worker runs.
# The Worker itself refuses, in production, any PG_DATABASE_URL that does not log in as crewflow_owner (runtime-db-config.ts
# checkRuntimeLogin), before connecting: a Worker started without this script stops instead of using the admin.
# Exit 64 = refusal (fixed message), 70 = unexpected. Never prints a URL, a password, a host or a database name.
set -eu

refuse() {
  echo "worker-start: REFUSED - $1" >&2
  exit "${2:-64}"
}

if [ "$#" -ne 0 ]; then
  refuse 'worker-start.sh takes no arguments (it starts the Worker only; one-off commands run from rab-api).'
fi
if [ -n "${PG_DATABASE_PASSWORD:-}" ]; then
  refuse 'PG_DATABASE_PASSWORD must never be set on the worker service: only compose reads it (the bundled db and the default admin URL); the Worker receives PG_DATABASE_URL and connects only as crewflow_owner.'
fi
if [ -z "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL is required: the database admin URL (the bundled db by default), or a crewflow_owner URL.'
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
crewflow_bundled_db_ca

STATUS=0
RUNTIME_URL="$(node packages/rab-server/dist/database/typeorm/scripts/owner-login/derive-runtime-url.js 4>&1 1>&2)" || STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  RUNTIME_URL=""
  refuse 'could not build the crewflow_owner connection from PG_DATABASE_URL and APP_SECRET (see the derive-runtime-url line above).' "$STATUS"
fi
if [ -z "$RUNTIME_URL" ]; then
  refuse 'the derive step returned an empty crewflow_owner connection.' 70
fi
export PG_DATABASE_URL="$RUNTIME_URL"
unset RUNTIME_URL PG_DATABASE_PASSWORD
exec /sbin/tini -s -- node packages/rab-worker/dist/main.js
