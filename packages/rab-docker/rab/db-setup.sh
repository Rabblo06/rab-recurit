#!/bin/sh
# Database setup the Twenty way (owner decision 2026-11-18, "change PR #125 option 2 to Twenty's way"): the one-shot
# `db-setup` service's ENTRYPOINT, from the same image as rab-api / rab-worker. Twenty's equivalent is the
# `ensure-database-exists` init container, which alone holds the superuser secret and creates the app user with the app
# user's own password (twentyhq/twenty@eedb0a73 packages/twenty-docker/helm/twenty/templates/deployment-server.yaml:82-128);
# Twenty's server and worker receive only PG_DATABASE_URL, the app user's URL (:148-155, deployment-worker.yaml:81-88).
#
# PG_DATABASE_URL is ALWAYS the crewflow_owner URL, and it is the SAME value rab-api and rab-worker receive (compose gives
# all three the same expression). Three modes:
#   a. the BUNDLED db (default: CREWFLOW_BUNDLED_DB unset or 1, no PG_ADMIN_URL): PG_DATABASE_URL is compose's bundled
#      crewflow_owner URL, built from PG_DATABASE_APP_PASSWORD (`openssl rand -hex 32`); the admin is the bundled db's
#      superuser, whose URL compose builds from PG_DATABASE_PASSWORD into CREWFLOW_BUNDLED_DB_ADMIN_URL; this script hands
#      it to the child as PG_ADMIN_URL. Refused (64) when either password is empty, or the app password is not 32+
#      characters of A-Z a-z 0-9 _ - (it is interpolated unencoded into the URL);
#   b. YOUR OWN database with an admin login: PG_ADMIN_URL (its admin URL, the same database) + PG_DATABASE_URL (the
#      crewflow_owner URL you chose the password of): crewflow_owner is created with that password if missing, and its
#      password is SET to it when it does not log in;
#   c. YOUR OWN database, crewflow_owner created by hand: PG_DATABASE_URL only (CREWFLOW_BUNDLED_DB=0): read-only checks.
# In modes a and b, once the schema bootstrap is complete for this image, the child also removes CREATEROLE from
# crewflow_owner (and marks it while the bootstrap is still to come); see owner-bootstrap.ts.
# Refused here, before anything runs: arguments, PG_DATABASE_PASSWORD / PG_DATABASE_APP_PASSWORD / APP_SECRET in this
# container (compose only interpolates the passwords; APP_SECRET is never part of a database credential), an empty
# PG_DATABASE_URL or crewflow_owner password, and CREWFLOW_BUNDLED_DB=0 with a PG_DATABASE_URL that still names the bundled
# host `db`. Everything about the URLs' contents (login, same database, pooler, TLS, ...) is the child's.
# PG_ADMIN_URL reaches no other service: rab-api and rab-worker refuse it (api-prestart.sh, worker-start.sh, the in-process
# guard). This script writes NO file (no target file, no password file, no volume) and takes no file lock: every write of
# the child runs in a transaction under a PostgreSQL advisory lock, which serialises concurrent runs against one database.
# Exit 0 = done; 64 = refusal; anything else = failure (rab-api is not started: depends_on service_completed_successfully).
# Prints fixed lines only (the child's): never a URL, a password, a host or a database name. Never traces the shell.
set -eu

refuse() {
  echo "db-setup: REFUSED - $1" >&2
  exit "${2:-64}"
}

if [ "$#" -ne 0 ]; then
  refuse 'db-setup.sh takes no arguments.'
fi
if [ -n "${PG_DATABASE_PASSWORD:-}" ]; then
  refuse 'PG_DATABASE_PASSWORD must never reach a container but the bundled db: compose builds the superuser URL from it.'
fi
if [ -n "${PG_DATABASE_APP_PASSWORD:-}" ]; then
  refuse 'PG_DATABASE_APP_PASSWORD must never reach a container: compose builds the crewflow_owner URL (PG_DATABASE_URL) from it.'
fi
if [ -n "${APP_SECRET:-}" ]; then
  refuse 'APP_SECRET must never reach db-setup: it is never part of a database credential (the crewflow_owner password is the one inside PG_DATABASE_URL).'
fi
case "${CREWFLOW_BUNDLED_DB:-1}" in
  0 | 1) ;;
  *) refuse 'CREWFLOW_BUNDLED_DB must be exactly 0 (your own database) or 1 (the bundled db; unset = 1).' ;;
esac

# The host of a database URL (the same parsing as the CA block below). Only presence and the host are read here.
url_host() {
  u_rest="${1#*://}"
  u_authority="${u_rest%%[/?#]*}"
  u_hostport="${u_authority##*@}"
  printf '%s' "${u_hostport%%:*}"
  unset u_rest u_authority u_hostport
}

if [ -z "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL is empty: it is always required, the crewflow_owner URL rab-api and rab-worker use (bundled db: set PG_DATABASE_APP_PASSWORD; your own database: your crewflow_owner URL, direct host, sslmode=verify-full).'
fi
case "$PG_DATABASE_URL" in
  *://crewflow_owner:@*)
    refuse 'the crewflow_owner password in PG_DATABASE_URL is empty: for the bundled db set PG_DATABASE_APP_PASSWORD (compose.env; openssl rand -hex 32); with your own database put the crewflow_owner password in PG_DATABASE_URL.' ;;
esac

if [ -n "${PG_ADMIN_URL:-}" ]; then
  # b. Your own database's admin URL (CREWFLOW_BUNDLED_DB=0; with 1 the bundled db simply runs unused).
  MODE=admin
elif [ "${CREWFLOW_BUNDLED_DB:-1}" = 1 ]; then
  # a. The bundled db: its superuser URL, built by compose from PG_DATABASE_PASSWORD (compose cannot require that value only
  # for the bundled db, so the requirement is checked here, and by the db service itself, at start: fail closed).
  MODE=bundled
  case "${CREWFLOW_BUNDLED_DB_ADMIN_URL:-}" in
    '') refuse 'the bundled database URL is missing from this service definition (CREWFLOW_BUNDLED_DB_ADMIN_URL); use the committed compose file.' ;;
    postgresql://postgres:@*) refuse 'PG_DATABASE_PASSWORD is required for the bundled database (compose.env; openssl rand -hex 32). With your own database set CREWFLOW_BUNDLED_DB=0 and PG_DATABASE_URL (plus PG_ADMIN_URL to have db-setup create crewflow_owner) instead.' ;;
  esac
  PG_ADMIN_URL="$CREWFLOW_BUNDLED_DB_ADMIN_URL"
  export PG_ADMIN_URL
  # Review of PR #230, I-2 (the same rule as the db service's superuser password): the bundled crewflow_owner password is
  # interpolated unencoded into PG_DATABASE_URL, so it must be 32+ characters of A-Z a-z 0-9 _ - (64 hex recommended).
  if [ "$(url_host "$PG_DATABASE_URL")" = db ]; then
    app_pw="${PG_DATABASE_URL#*://crewflow_owner:}"
    app_pw="${app_pw%%@*}"
    case "$app_pw" in
      *[!A-Za-z0-9_-]*) app_pw_ok=no ;;
      *) if [ "${#app_pw}" -ge 32 ]; then app_pw_ok=yes; else app_pw_ok=no; fi ;;
    esac
    unset app_pw
    if [ "$app_pw_ok" != yes ]; then
      refuse 'PG_DATABASE_APP_PASSWORD must be 32+ characters of A-Z a-z 0-9 _ - for the bundled database (openssl rand -hex 32). Value not shown.'
    fi
    unset app_pw_ok
  fi
else
  # c. Your own database, crewflow_owner created by hand: read-only checks only.
  MODE=owner
fi
if [ "${CREWFLOW_BUNDLED_DB:-1}" = 0 ] && [ "$(url_host "$PG_DATABASE_URL")" = db ]; then
  refuse 'CREWFLOW_BUNDLED_DB=0 (your own database) but PG_DATABASE_URL still names the bundled host db: put your crewflow_owner URL in PG_DATABASE_URL (direct host, sslmode=verify-full), plus PG_ADMIN_URL to have db-setup create crewflow_owner.'
fi
# The bundled superuser URL is never needed again; the child reads PG_ADMIN_URL / PG_DATABASE_URL only.
unset CREWFLOW_BUNDLED_DB_ADMIN_URL
echo "db-setup: mode $MODE (bundled = the bundled db's superuser creates crewflow_owner; admin = your PG_ADMIN_URL does; owner = read-only checks of your crewflow_owner)"

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
crewflow_bundled_db_ca "${PG_ADMIN_URL:-$PG_DATABASE_URL}"

STATUS=0
# The child runs in the background so a stop (TERM/INT to this PID 1) reaches it. A transaction it had open is rolled back
# by the server when its connection ends.
node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js &
CHILD=$!
trap 'kill -TERM "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null; exit 143' TERM INT
wait "$CHILD" || STATUS=$?
trap - TERM INT
case "$STATUS" in
  0) ;;
  64) refuse 'the database setup step refused (see the [owner-bootstrap] line above).' 64 ;;
  *) refuse "the database setup step failed (see the [owner-bootstrap] lines above; exit $STATUS)." "$STATUS" ;;
esac
echo 'db-setup: done (crewflow_owner ready for PG_DATABASE_URL)'
