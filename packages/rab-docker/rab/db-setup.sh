#!/bin/sh
# Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A): the one-shot `db-setup` service's ENTRYPOINT, from the same
# image as rab-api / rab-worker. Twenty's equivalent is the `ensure-database-exists` init container, which alone holds the
# superuser secret (twentyhq/twenty@eedb0a73 packages/twenty-docker/helm/twenty/templates/deployment-server.yaml:81-130).
# It is the ONLY service that receives PG_DATABASE_URL, the ONE database setting (compose.env): your own database's ADMIN
# URL, or an existing crewflow_owner URL, or (unset) the bundled db's superuser built from PG_DATABASE_PASSWORD; plus the TLS
# CA. NOT APP_SECRET (refused here: it is never part of a database credential). It runs the bootstrap child
# (scripts/owner-login/bootstrap-owner-login.js) with CREWFLOW_DB_TARGET_FILE set:
#   - admin / bundled URL: crewflow_owner is created if missing, with a RANDOM password kept in the password file
#     (/run/crewflow/db-target/owner-password, 0400) and reused on every later start (Twenty: secret-db-url.yaml:3-8); a
#     stored password that no longer logs in is refused (64: delete the password file and start again with the admin
#     address); a lost password file + the admin URL resets the password once (a Crewflow addition);
#   - existing crewflow_owner URL: read-only checks only; its password is copied into the password file; the database is
#     never written to and the password never changed.
# In every mode it then writes the CREDENTIAL-FREE target file /run/crewflow/db-target/target.json
# ({"v":1,"host","port","database","params"}: no user, no password; temp file + rename, mode 0644). Both files live on a
# small named volume that rab-api and rab-worker mount read-only; they never see PG_DATABASE_URL.
# The previous target file is removed first, so a failed setup never leaves an old one behind; the password file is never
# removed here (it is the credential of an existing role). Exit 0 = done; 64 = refusal;
# anything else = failure (rab-api is not started: depends_on service_completed_successfully, and its own bounded wait).
# Prints fixed lines only (the child's): never a URL, a password, a host or a database name. Never traces the shell.
set -eu

TARGET=/run/crewflow/db-target/target.json
PASSWORD_FILE=/run/crewflow/db-target/owner-password

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
if [ -n "${APP_SECRET:-}" ]; then
  refuse 'APP_SECRET must never reach db-setup: it is never part of a database credential (the crewflow_owner password is a random value in the password file).'
fi
if [ -z "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL is required: the database admin URL, or an existing crewflow_owner URL (the bundled db by default).'
fi
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
if [ ! -s "$TARGET" ]; then
  refuse 'the database setup step reported success but wrote no target file; rab-api and rab-worker cannot start.' 70
fi
if [ ! -s "$PASSWORD_FILE" ]; then
  rm -f "$TARGET" "$TARGET.tmp"
  refuse 'the database setup step reported success but no crewflow_owner password file exists; rab-api and rab-worker cannot start.' 70
fi
echo 'db-setup: done (crewflow_owner ready, database target file written)'
