#!/bin/sh
# Database setup (PR #125 option A, owner decision 2026-11-13): the one-shot `db-setup` service's ENTRYPOINT, from the same
# image as rab-api / rab-worker. It is the ONLY app-image service that receives the database ADMIN URL (PG_DATABASE_URL:
# the bundled db's superuser by default, or PG_DATABASE_ADMIN_URL from compose.env), plus APP_SECRET and the TLS CA. It runs
# the bootstrap child (scripts/owner-login/bootstrap-owner-login.js) with CREWFLOW_DB_TARGET_FILE set: the child creates
# crewflow_owner, or resets its password to the one derived from APP_SECRET, grants it the database, and writes the
# CREDENTIAL-FREE target file /run/crewflow/db-target/target.json ({"v":1,"host","port","database","params"}: no user, no
# password; temp file + rename, mode 0644) on a small named volume that rab-api and rab-worker mount read-only.
# Pass-through (PG_DATABASE_URL is a crewflow_owner URL, DB-SETUP-PLAN §7.1): the child does not connect and writes no
# target; rab-api / rab-worker receive that same crewflow_owner URL themselves.
# The previous target file is removed first, so a failed setup never leaves an old one behind. Exit 0 = done; 64 = refusal;
# anything else = failure (rab-api is not started: depends_on service_completed_successfully, and its own bounded wait).
# Prints fixed lines only (the child's): never a URL, a password, a host or a database name. Never traces the shell.
set -eu

TARGET=/run/crewflow/db-target/target.json

refuse() {
  echo "db-setup: REFUSED - $1" >&2
  exit "${2:-64}"
}

if [ "$#" -ne 0 ]; then
  refuse 'db-setup.sh takes no arguments.'
fi
if [ -n "${PG_DATABASE_PASSWORD:-}" ]; then
  refuse 'PG_DATABASE_PASSWORD must never reach a container: compose builds the admin URL from it.'
fi
if [ -z "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL is required: the database admin URL (the bundled db by default), or a crewflow_owner URL.'
fi
case "$PG_DATABASE_URL" in
  postgres://crewflow_owner[:@]*|postgresql://crewflow_owner[:@]*) PASS_THROUGH=1 ;;
  *) PASS_THROUGH=0 ;;
esac
rm -f "$TARGET" "$TARGET.tmp"
export CREWFLOW_DB_TARGET_FILE="$TARGET"

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
node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js || STATUS=$?
case "$STATUS" in
  0) ;;
  64) rm -f "$TARGET" "$TARGET.tmp"; refuse 'the database setup step refused (see the [owner-bootstrap] line above).' 64 ;;
  *) rm -f "$TARGET" "$TARGET.tmp"; refuse "the database setup step failed (see the [owner-bootstrap] lines above; exit $STATUS)." "$STATUS" ;;
esac
if [ "$PASS_THROUGH" = 1 ]; then
  echo 'db-setup: done (pass-through: PG_DATABASE_URL is the crewflow_owner login; nothing to set up, no target file)'
  exit 0
fi
if [ ! -s "$TARGET" ]; then
  refuse 'the database setup step reported success but wrote no target file; rab-api and rab-worker cannot start.' 70
fi
echo 'db-setup: done (crewflow_owner ready, database target file written)'
