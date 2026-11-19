#!/bin/sh
# Worker start: rab-worker's ENTRYPOINT in every deploy compose file (["./worker-start.sh"], no compose init). Runs from
# /app (the image WORKDIR) as PID 1, then execs the image's tini: `exec /sbin/tini -s -- node packages/rab-worker/dist/main.js`.
# tini becomes PID 1 (signal forwarding, zombie reaping) and the Worker its child, so the Worker's watchdog SIGKILL (ignored
# by the kernel for PID 1) still works without compose's `init: true`.
#
# DATABASE (owner decision 2026-11-18, "change PR #125 option 2 to Twenty's way"): the Worker reads PG_DATABASE_URL, the
# crewflow_owner URL, straight from its environment, like Twenty's worker (twentyhq/twenty@eedb0a73
# packages/twenty-docker/helm/twenty/templates/deployment-worker.yaml:81-88). There is no target file, no password file and
# no derive step any more. This script:
#   1. refuses arguments, PG_DATABASE_PASSWORD and PG_DATABASE_APP_PASSWORD (compose only interpolates them), PG_ADMIN_URL
#      (and its other names), and any OTHER variable holding a postgres:// URL or a libpq password DSN (exit 64);
#   2. refuses an empty PG_DATABASE_URL, one whose crewflow_owner password is empty, and one whose login is not crewflow_owner
#      by a pure userinfo parse, before node runs (security review of PR #246, L2; exit 64);
#   3. sets PG_SSL_CA_CERT_PATH to the bundled db's CA when the URL's host is exactly `db` and neither it nor
#      PG_SSL_CA_CERT is set (the block below is identical in api-prestart.sh and db-setup.sh;
#      run-prestart-shell-tests.cjs compares them);
#   4. execs tini. The Worker itself retries a 28P01 first login (db-setup may still be setting the password) for up to
#      120 s (core/runtime/owner-password-wait.ts), and refuses, in production, a PG_DATABASE_URL that does not log in as
#      crewflow_owner or has a transaction-pooler shape before connecting (runtime-db-config.ts checkRuntimeLogin), and a
#      SUPERUSER / BYPASSRLS / CREATEDB / REPLICATION / unmarked CREATEROLE login once connected (the boot gates).
# Exit 64 = refusal (fixed message), 70 = unexpected. Never prints a URL, a password, a host or a database name.
set -eu

refuse() {
  echo "worker-start: REFUSED - $1" >&2
  exit "${2:-64}"
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

if [ "$#" -ne 0 ]; then
  refuse 'worker-start.sh takes no arguments (it starts the Worker only; one-off commands run from rab-api).'
fi
if [ -n "${PG_DATABASE_PASSWORD:-}" ]; then
  refuse 'PG_DATABASE_PASSWORD must never be set on the worker service: only compose reads it (the bundled db and its superuser URL for db-setup); the Worker connects only as crewflow_owner.'
fi
if [ -n "${PG_DATABASE_APP_PASSWORD:-}" ]; then
  refuse 'PG_DATABASE_APP_PASSWORD must never be set on the worker service: compose interpolates it into PG_DATABASE_URL and never passes it on.'
fi
# PG_ADMIN_URL (owner decisions 2026-11-17 and 2026-11-18, Twenty's model): the database admin URL belongs ONLY to the
# one-shot db-setup service (never-in-runtime-env.ts; the in-process guard refuses it as well), and so do its retired name
# and db-setup's bundled-db superuser URL. The compose files pin PG_ADMIN_URL to "" here (owner decision L-2): empty is
# allowed, any value refused.
for name in PG_ADMIN_URL PG_ADMIN_DIRECT_URL PG_DATABASE_ADMIN_URL CREWFLOW_BUNDLED_DB_ADMIN_URL; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then refuse "$name must never be set on the worker service: it is a database admin URL, read only by the one-shot db-setup service (which creates crewflow_owner). The Worker connects only as crewflow_owner. Value not shown."; fi
done
# Security review of PR #230, L-1: an admin URL under ANY other name. No variable but the Worker's own PG_DATABASE_URL may
# hold a PostgreSQL URL here.
for forbidden in $(crewflow_db_url_names); do
  refuse "$forbidden holds a PostgreSQL URL or a libpq password DSN: the worker service holds exactly one database credential, PG_DATABASE_URL (the crewflow_owner URL). Value not shown."
done

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

# Part C2 test seam (the search_path trap, engine/core-modules/tenant/business-tables.ts): refused outside NODE_ENV=test, as
# in api-prestart.sh and runtime-db-config.ts TEST_SEAM_VARS.
if [ "${NODE_ENV:-}" != test ] && [ -n "${CREWFLOW_TEST_SEARCH_PATH_TRAP:-}" ]; then
  refuse 'CREWFLOW_TEST_SEARCH_PATH_TRAP is a test seam: it is allowed only with NODE_ENV=test. Remove it.'
fi

if [ -z "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL is empty: it is the crewflow_owner URL (bundled db: set PG_DATABASE_APP_PASSWORD, openssl rand -hex 32; your own database: your crewflow_owner URL, direct host, sslmode=verify-full).'
fi
case "$PG_DATABASE_URL" in
  *://crewflow_owner:@*)
    refuse 'PG_DATABASE_URL has an empty crewflow_owner password: for the bundled db set PG_DATABASE_APP_PASSWORD (openssl rand -hex 32); with your own database put the crewflow_owner password in PG_DATABASE_URL. Value not shown.' ;;
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
  refuse 'PG_DATABASE_URL does not log in as crewflow_owner: it is always the crewflow_owner URL. An admin URL belongs only in PG_ADMIN_URL of db-setup (a compose.env from before 2026-11-18 had the admin URL in PG_DATABASE_URL: move it to PG_ADMIN_URL and put the crewflow_owner URL in PG_DATABASE_URL). Value not shown.'
fi
export PG_DATABASE_URL
crewflow_bundled_db_ca "$PG_DATABASE_URL"
exec /sbin/tini -s -- node packages/rab-worker/dist/main.js
