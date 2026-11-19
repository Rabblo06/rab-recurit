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
#   b. YOUR OWN database with an admin login: PG_ADMIN_URL (its admin URL, the same database, pasted as-is) + the crewflow_owner
#      URL, which compose builds (owner decision 2026-11-19, "You set one shared password") from PG_DATABASE_APP_PASSWORD
#      (openssl rand -hex 32) and PG_DATABASE_HOST / PG_DATABASE_PORT / PG_DATABASE_NAME (copied from the admin URL), or
#      which you set as PG_DATABASE_URL yourself (never both): crewflow_owner is created with that password if missing,
#      and its password is SET to it when it does not log in. The SCRAM verifier is sent first; a server that refuses
#      pre-hashed passwords gets the plain-text password ONCE, only over verified TLS (owner-bootstrap.ts). A pooled
#      PG_ADMIN_URL is refused by capability; PG_ADMIN_DIRECT_URL (the direct address of the same login and database,
#      db-setup and db-harden only) is then used instead of it;
#   c. YOUR OWN database, crewflow_owner created by hand: PG_DATABASE_URL only (CREWFLOW_BUNDLED_DB=0): read-only checks.
# In modes a and b, once the schema bootstrap is complete for this image, the child also removes CREATEROLE from
# crewflow_owner (and marks it while the bootstrap is still to come); see owner-bootstrap.ts.
#
# Two invocations (owner decision M1, 2026-11-18: the CREATEROLE window closes in the same deploy):
#   db-setup.sh           the one-shot `db-setup` service (before rab-api): create / check crewflow_owner, as above;
#   db-setup.sh harden    the one-shot `db-harden` service (the same image, started beside rab-api in the same deploy, never
#                         a dependency of it): the same refusals and mode selection, then the child's --harden mode, which
#                         waits read-only (bounded: CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS, unset = 1200, 60-7200; 1-7200 with
#                         NODE_ENV=test) until the ledger holds every migration of this image, then removes CREATEROLE and
#                         the mark as the admin. Mode c (no admin login) has nothing to harden: one line, exit 0, no node.
#
# Refused here, before anything runs: any other argument, PG_DATABASE_PASSWORD / PG_DATABASE_APP_PASSWORD / APP_SECRET in
# this container (compose only interpolates the passwords; APP_SECRET is never part of a database credential), an empty
# PG_DATABASE_URL or crewflow_owner password, a PG_DATABASE_URL whose login is not crewflow_owner (security review of PR
# #246, L2: an old compose.env that still has the admin URL there), a PG_ADMIN_URL whose login IS crewflow_owner, and
# CREWFLOW_BUNDLED_DB=0 with a PG_DATABASE_URL that still names the bundled host `db`. Everything else about the URLs'
# contents (same database, pooler, TLS, ...) is the child's.
# PG_ADMIN_URL reaches no other service: rab-api and rab-worker refuse it (api-prestart.sh, worker-start.sh, the in-process
# guard). This script writes NO file (no target file, no password file, no volume) and takes no file lock: every write of
# the child runs in a transaction under a PostgreSQL advisory lock, which serialises concurrent runs against one database.
# Before the child, it waits (bounded, CREWFLOW_DB_WAIT_SECONDS, default 170 s) until the database accepts connections
# (BEGIN crewflow wait-for-db below; neither db-setup nor db-harden has depends_on: db).
# Exit 0 = done; 64 = refusal; anything else = failure (70 among them: the database did not accept connections in time)
# (rab-api is not started: depends_on service_completed_successfully).
# Prints fixed lines only (the child's): never a URL, a password, a host or a database name. Never traces the shell.
set -eu

PREFIX=db-setup
HARDEN=0
refuse() {
  echo "$PREFIX: REFUSED - $1" >&2
  exit "${2:-64}"
}

case "$#:${1:-}" in
  0:) ;;
  1:harden)
    HARDEN=1
    PREFIX=db-harden
    ;;
  *) refuse 'db-setup.sh takes no argument, or exactly one: harden.' ;;
esac
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
if [ "$HARDEN" = 1 ]; then
  # The bounded wait of the --harden child (owner decision M1): digits only, 60-7200 s (1-7200 under NODE_ENV=test).
  HARDEN_TIMEOUT="${CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS:-1200}"
  if [ "${NODE_ENV:-}" = test ]; then HARDEN_MIN=1; else HARDEN_MIN=60; fi
  case "$HARDEN_TIMEOUT" in
    '' | *[!0-9]*) refuse "CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS must be a whole number of seconds from $HARDEN_MIN to 7200 (unset = 1200)." ;;
  esac
  if [ "${#HARDEN_TIMEOUT}" -gt 5 ] || [ "$HARDEN_TIMEOUT" -lt "$HARDEN_MIN" ] || [ "$HARDEN_TIMEOUT" -gt 7200 ]; then
    refuse "CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS must be a whole number of seconds from $HARDEN_MIN to 7200 (unset = 1200)."
  fi
  CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS="$HARDEN_TIMEOUT"
  export CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS
  unset HARDEN_TIMEOUT HARDEN_MIN
fi

# The host of a database URL (the same parsing as the CA block below). Only presence and the host are read here.
url_host() {
  u_rest="${1#*://}"
  u_authority="${u_rest%%[/?#]*}"
  u_hostport="${u_authority##*@}"
  printf '%s' "${u_hostport%%:*}"
  unset u_rest u_authority u_hostport
}

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

if [ -z "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL is empty: it is always required, the crewflow_owner URL rab-api and rab-worker use (bundled db: set PG_DATABASE_APP_PASSWORD; your own database: your crewflow_owner URL, direct host, sslmode=verify-full).'
fi
case "$PG_DATABASE_URL" in
  *://crewflow_owner:@*)
    refuse 'the crewflow_owner password in PG_DATABASE_URL is empty: for the bundled db set PG_DATABASE_APP_PASSWORD (compose.env; openssl rand -hex 32); with your own database put the crewflow_owner password in PG_DATABASE_URL.' ;;
esac
if ! crewflow_is_owner_login "$PG_DATABASE_URL"; then
  refuse 'PG_DATABASE_URL does not log in as crewflow_owner: it is always the crewflow_owner URL. An admin URL belongs only in PG_ADMIN_URL of db-setup (a compose.env from before 2026-11-18 had the admin URL in PG_DATABASE_URL: move it to PG_ADMIN_URL and put the crewflow_owner URL in PG_DATABASE_URL). Value not shown.'
fi
if [ -n "${PG_ADMIN_URL:-}" ] && crewflow_is_owner_login "$PG_ADMIN_URL"; then
  refuse 'PG_ADMIN_URL logs in as crewflow_owner, the app login: PG_ADMIN_URL is your database admin login (db-setup creates crewflow_owner with it). Remove it to have db-setup only check crewflow_owner. Value not shown.'
fi
# PR #258: PG_DATABASE_SESSION_URL, the session address of the crewflow_owner login (the child checks the same login,
# password and database as PG_DATABASE_URL and uses it for its crewflow_owner sessions).
if [ -n "${PG_DATABASE_SESSION_URL:-}" ] && ! crewflow_is_owner_login "$PG_DATABASE_SESSION_URL"; then
  refuse 'PG_DATABASE_SESSION_URL does not log in as crewflow_owner: it is the session address of PG_DATABASE_URL (the same login and database). Value not shown.'
fi
# Owner decision 2026-11-19: PG_ADMIN_DIRECT_URL, the direct address of the PG_ADMIN_URL login (the child checks it names the
# same login and database). Only beside PG_ADMIN_URL, and never the app login.
if [ -n "${PG_ADMIN_DIRECT_URL:-}" ]; then
  if [ -z "${PG_ADMIN_URL:-}" ]; then
    refuse 'PG_ADMIN_DIRECT_URL is set without PG_ADMIN_URL: it is only the direct address of the PG_ADMIN_URL login. Set both, or put the direct address in PG_ADMIN_URL. Value not shown.'
  fi
  if crewflow_is_owner_login "$PG_ADMIN_DIRECT_URL"; then
    refuse 'PG_ADMIN_DIRECT_URL logs in as crewflow_owner, the app login: it is the direct address of your database admin login (PG_ADMIN_URL). Value not shown.'
  fi
fi

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
  refuse 'CREWFLOW_BUNDLED_DB=0 (your own database) but PG_DATABASE_URL still names the bundled host db: set PG_DATABASE_HOST (and PG_DATABASE_NAME / PG_DATABASE_PORT) to your database, copied from PG_ADMIN_URL, with PG_DATABASE_APP_PASSWORD; or put your crewflow_owner URL in PG_DATABASE_URL (direct host, sslmode=verify-full).'
fi
# The bundled superuser URL is never needed again; the child reads PG_ADMIN_URL / PG_DATABASE_URL only.
unset CREWFLOW_BUNDLED_DB_ADMIN_URL
if [ "$HARDEN" = 1 ] && [ "$MODE" = owner ]; then
  # Mode c: no admin login, so nothing can remove CREATEROLE here (the operator does it; the boot gate enforces the expiry).
  echo 'db-harden: no admin login (mode c): nothing to harden'
  exit 0
fi
# BEGIN crewflow wait-for-db
# Twenty's Helm wait-for-db init container, re-implemented (not copied): db-setup and db-harden have no `depends_on: db`,
# because with CREWFLOW_BUNDLED_DB=0 the bundled db has no container and a platform that does not skip a 0-replica dependency
# (OpenShip: 'Dependency "db" has no container for service_healthy') then never starts them. Instead they wait for the
# database they will use: PG_ADMIN_URL's host when it is set (mode b: PG_ADMIN_URL + PG_DATABASE_URL, the same database;
# inside db-setup.sh also mode a, where PG_ADMIN_URL is the bundled superuser URL by then), else the bundled db (host db,
# mode a, from CREWFLOW_BUNDLED_DB_ADMIN_URL: the compose wrapper runs before db-setup.sh picks the mode), else
# PG_DATABASE_URL's host (mode c). The probe is pg_isready's check, in node (the image has no pg_isready): a TCP connect and a
# protocol-3.0 startup message with a FIXED placeholder login (crewflow_wait_for_db), no TLS and no password; an
# authentication request or any error other than 57P03 (starting up / shutting down) means the server accepts connections.
# It never authenticates, never runs a query and reads nothing but the URL's host and port; the bootstrap child then makes
# the real verify-full connection. Bounded by CREWFLOW_DB_WAIT_SECONDS (unset or empty = 170; 0 = do not wait; at most 900)
# on the monotonic clock; a progress line whenever the result changes and every 10 s; on timeout ONE fixed line and exit 70
# (a failure, like the bootstrap child's own "did not accept a connection" 70; 64 stays for settings the operator must
# change, such as an invalid CREWFLOW_DB_WAIT_SECONDS). The default 170 s stays inside OpenShip's 180 s window for a
# service_completed_successfully dependency without a health check (security review L1), so on a dead database db-setup
# fails with its own line first. Prints no URL, host, login, password or database name (the lines say "db-setup" also in
# db-harden). Not waited for (the refusal or the child's check comes at once): a bad CREWFLOW_BUNDLED_DB, an empty
# PG_DATABASE_URL or an empty crewflow_owner password in it, the bundled db without its password, an unparseable URL. In the
# compose wrapper ONLY those come before the wait: db-setup.sh's own preamble refusals (arguments, a password variable or
# APP_SECRET present, a login that is not crewflow_owner) run after it (review L2). Safe to run twice: the same block runs
# in the db-setup wrapper of docker-compose.production.yml / docker-compose.image.yml (the published image's db-setup.sh
# has no wait) and again here (run-prestart-shell-tests.cjs and compose-owner-login.cjs require the copies to be identical).
crewflow_wait_for_db() {
  case "${CREWFLOW_BUNDLED_DB:-1}" in 0 | 1) ;; *) return 0 ;; esac
  case "${PG_DATABASE_URL:-}" in '' | *://crewflow_owner:@*) return 0 ;; esac
  if [ -n "${PG_ADMIN_URL:-}" ]; then
    crewflow_wait_url="$PG_ADMIN_URL"
  elif [ "${CREWFLOW_BUNDLED_DB:-1}" = 1 ]; then
    crewflow_wait_url="${CREWFLOW_BUNDLED_DB_ADMIN_URL:-}"
    case "$crewflow_wait_url" in '' | postgresql://postgres:@*) crewflow_wait_url=''; return 0 ;; esac
  else
    crewflow_wait_url="$PG_DATABASE_URL"
  fi
  case "${CREWFLOW_DB_WAIT_SECONDS:-170}" in
    *[!0-9]* | ????*) crewflow_wait_limit=invalid ;;
    *) crewflow_wait_limit="${CREWFLOW_DB_WAIT_SECONDS:-170}" ;;
  esac
  if [ "$crewflow_wait_limit" = invalid ] || [ "$crewflow_wait_limit" -gt 900 ]; then
    echo 'db-setup: REFUSED - CREWFLOW_DB_WAIT_SECONDS must be a whole number of seconds from 0 to 900 (unset = 170; 0 = do not wait). Value not shown.' >&2
    exit 64
  fi
  if [ "$crewflow_wait_limit" -eq 0 ]; then crewflow_wait_url=''; return 0; fi
  crewflow_wait_status=0
  CREWFLOW_DB_WAIT_URL="$crewflow_wait_url" CREWFLOW_DB_WAIT_LIMIT="$crewflow_wait_limit" node -e '
"use strict";
const net = require("net");
const limit = Number(process.env.CREWFLOW_DB_WAIT_LIMIT);
let host = "";
let port = 5432;
try {
  const u = new URL(process.env.CREWFLOW_DB_WAIT_URL || "");
  host = decodeURIComponent(u.hostname);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (u.port) port = Number(u.port);
  if (u.searchParams.has("host") || u.searchParams.has("port")) host = "";
} catch (e) {
  host = "";
}
delete process.env.CREWFLOW_DB_WAIT_URL;
if (!host || host.startsWith("/") || !(Number.isInteger(port) && port > 0 && port < 65536)) {
  console.log("db-setup: not waiting for the database: its address could not be read from the URL (the setup step checks the URL next)");
  process.exit(0);
}
const which = host === "db" ? "the bundled database (db)" : "your database";
const started = process.hrtime.bigint();
const elapsed = () => Number((process.hrtime.bigint() - started) / 1000000n) / 1000;
const startup = (() => {
  const params = Buffer.from("user\x00crewflow_wait_for_db\x00database\x00crewflow_wait_for_db\x00application_name\x00crewflow-db-setup-wait\x00\x00", "latin1");
  const head = Buffer.alloc(8);
  head.writeInt32BE(8 + params.length, 0);
  head.writeInt32BE(196608, 4);
  return Buffer.concat([head, params]);
})();
const probe = (timeoutMs) => new Promise((resolve) => {
  let done = false;
  let buf = Buffer.alloc(0);
  const s = net.connect({ host: host, port: port });
  const finish = (result) => {
    if (done) return;
    done = true;
    s.destroy();
    resolve(result);
  };
  s.setTimeout(timeoutMs, () => finish("no answer in time"));
  s.on("error", (e) => {
    const code = String((e && e.code) || "unknown");
    if (code === "ECONNREFUSED") finish("connection refused");
    else if (code === "ENOTFOUND" || code === "EAI_AGAIN") finish("host name not found yet");
    else finish("network error " + code.replace(/[^A-Z0-9_]/g, ""));
  });
  s.on("close", () => finish("connection closed before an answer"));
  s.on("connect", () => s.write(startup));
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf[0] === 0x52) return finish("ready");
    if (buf[0] !== 0x45) return finish("an answer that is not PostgreSQL");
    if (buf.length < 5) return;
    const len = buf.readInt32BE(1);
    if (len < 4 || len > 65536) return finish("ready");
    if (buf.length < 1 + len) return;
    const fields = buf.subarray(5, 1 + len).toString("latin1").split("\x00");
    const sqlstate = (fields.find((f) => f[0] === "C") || "").slice(1);
    finish(sqlstate === "57P03" ? "the server is starting up or shutting down (57P03)" : "ready");
  });
});
(async () => {
  let last = "";
  let nextReport = 0;
  for (;;) {
    const left = limit - elapsed();
    const result = await probe(Math.max(1000, Math.min(5000, Math.floor(left * 1000))));
    const t = elapsed();
    if (result === "ready") {
      console.log("db-setup: " + which + " accepts connections (waited " + Math.round(t) + "s)");
      process.exit(0);
    }
    if (result !== last || t >= nextReport) {
      console.log("db-setup: waiting for " + which + " to accept connections (" + Math.round(t) + "s of " + limit + "s): " + result);
      last = result;
      nextReport = t + 10;
    }
    if (t >= limit) {
      console.error("db-setup: REFUSED - the database did not accept connections within " + limit + "s (CREWFLOW_DB_WAIT_SECONDS). Nothing was changed. Check that it is running and reachable from this container, then start again.");
      process.exit(70);
    }
    await new Promise((r) => setTimeout(r, Math.min(2000, Math.ceil((limit - t) * 1000))));
  }
})().catch(() => {
  console.error("db-setup: REFUSED - the wait for the database stopped unexpectedly. Nothing was changed.");
  process.exit(70);
});
' &
  crewflow_wait_pid=$!
  trap 'kill -TERM "$crewflow_wait_pid" 2>/dev/null; exit 143' TERM INT
  wait "$crewflow_wait_pid" || crewflow_wait_status=$?
  trap - TERM INT
  unset crewflow_wait_url crewflow_wait_limit crewflow_wait_pid
  case "$crewflow_wait_status" in
    0) ;;
    70) exit 70 ;;
    *) echo "db-setup: REFUSED - the wait for the database stopped unexpectedly (exit $crewflow_wait_status). Nothing was changed." >&2; exit 70 ;;
  esac
}
# END crewflow wait-for-db
# After the refusals above (an invalid setting is refused at once, never waited for), before the bootstrap child: wait,
# bounded, until the database accepts connections (db-harden in mode c has returned above: it never connects).
crewflow_wait_for_db
echo "$PREFIX: mode $MODE (bundled = the bundled db's superuser; admin = your PG_ADMIN_URL; owner = read-only checks of your crewflow_owner)"

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
crewflow_bundled_db_ca "${PG_ADMIN_DIRECT_URL:-${PG_ADMIN_URL:-$PG_DATABASE_URL}}"

STATUS=0
# The child runs in the background so a stop (TERM/INT to this PID 1) reaches it. A transaction it had open is rolled back
# by the server when its connection ends.
# The child's only argument: --harden for the db-harden service, none for db-setup (positional parameters, so no word
# splitting of a variable is ever involved).
if [ "$HARDEN" = 1 ]; then set -- --harden; else set --; fi
node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js "$@" &
CHILD=$!
trap 'kill -TERM "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null; exit 143' TERM INT
wait "$CHILD" || STATUS=$?
trap - TERM INT
if [ "$HARDEN" = 1 ]; then
  case "$STATUS" in
    0) ;;
    64) refuse 'the CREATEROLE hardening step refused (see the [owner-bootstrap] line above); nothing was changed.' 64 ;;
    *) refuse "the CREATEROLE hardening step failed or timed out (see the [owner-bootstrap] lines above; exit $STATUS); nothing was changed." "$STATUS" ;;
  esac
  echo 'db-harden: done (crewflow_owner has no CREATEROLE once the schema is complete)'
  exit 0
fi
case "$STATUS" in
  0) ;;
  64) refuse 'the database setup step refused (see the [owner-bootstrap] line above).' 64 ;;
  *) refuse "the database setup step failed (see the [owner-bootstrap] lines above; exit $STATUS)." "$STATUS" ;;
esac
echo 'db-setup: done (crewflow_owner ready for PG_DATABASE_URL)'
