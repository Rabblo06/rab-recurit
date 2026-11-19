#!/bin/sh
# Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A): the one-shot `db-setup` service's ENTRYPOINT, from the same
# image as rab-api / rab-worker. Twenty's equivalent is the `ensure-database-exists` init container, which alone holds the
# superuser secret (twentyhq/twenty@eedb0a73 packages/twenty-docker/helm/twenty/templates/deployment-server.yaml:81-130).
# It is the ONLY service that receives a database URL from the operator (compose.env; owner decision 2026-11-17, Twenty's Helm
# model: the admin login lives only in the setup step), one of three modes:
#   a. the BUNDLED db (default: CREWFLOW_BUNDLED_DB unset or 1, neither URL set): its superuser URL, which compose builds from
#      PG_DATABASE_PASSWORD into CREWFLOW_BUNDLED_DB_ADMIN_URL; this script hands it to the child as PG_ADMIN_URL, and refuses
#      (64) when PG_DATABASE_PASSWORD was not set (that URL then has an empty password);
#   b. PG_ADMIN_URL: your own database's admin URL (CREWFLOW_BUNDLED_DB=0): crewflow_owner is created if missing;
#   c. PG_DATABASE_URL: the crewflow_owner URL you created yourself (CREWFLOW_BUNDLED_DB=0, no PG_ADMIN_URL): read-only
#      checks only, no provisioning. PG_DATABASE_URL ALWAYS means the app login: the child refuses any other login there
#      (the admin URL was renamed to PG_ADMIN_URL; it is never silently reinterpreted).
# Exactly one URL reaches the child (it refuses both, neither, and the retired PG_DATABASE_ADMIN_URL). Plus the TLS CA. NOT
# APP_SECRET (refused here: it is never part of a database credential). PG_ADMIN_URL reaches no other service: rab-api and
# rab-worker refuse it (api-prestart.sh, worker-start.sh, and the in-process guard). It runs the bootstrap child
# (scripts/owner-login/bootstrap-owner-login.js) with CREWFLOW_DB_TARGET_FILE set:
#   - admin / bundled URL (PG_ADMIN_URL): crewflow_owner is created if missing, with a RANDOM password kept in the password file
#     (/run/crewflow/db-target/owner-password, 0400) and reused on every later start (Twenty: secret-db-url.yaml:3-8); a
#     stored password that does not log in is refused (64: delete the password file and start again with the admin
#     address); a lost password file + the admin URL resets the password once (a Crewflow addition): the new password is
#     stored first as owner-password.next and becomes owner-password only after the COMMIT and a login with it;
#   - existing crewflow_owner URL (PG_DATABASE_URL): read-only checks only; its password is copied into the password file; the database is
#     never written to and the password never changed.
# In every mode it then writes the CREDENTIAL-FREE target file /run/crewflow/db-target/target.json
# ({"v":1,"host","port","database","params"}: no user, no password; temp file + rename, mode 0644). Both files live on a
# small named volume that rab-api and rab-worker mount read-only; they never see PG_ADMIN_URL or an operator's URL.
# One run per volume (security re-check F1, R1/R2): this script first takes the kernel lock (flock -n on fd 9, the
# volume's .db-setup.flock; a second run stops with exit 70); the bootstrap child inherits it and also takes the lock
# directory .db-setup.lock with this script's token (CREWFLOW_DB_SETUP_LOCK_TOKEN), and only then removes the previous
# target file and the temp files a killed run left. This script releases the directory on exit, only when the owner token
# in it is its own; the kernel releases the flock however the processes end. The password file is
# never removed here (it is the credential of an existing role). Before the child, it waits (bounded, CREWFLOW_DB_WAIT_SECONDS,
# default 170 s) until the database accepts connections (BEGIN crewflow wait-for-db below; db-setup has no depends_on: db).
# Exit 0 = done; 64 = refusal; anything else = failure (70 among them: the database did not accept connections in time)
# (rab-api is not started: depends_on service_completed_successfully, and its own bounded wait).
# Prints fixed lines only (the child's): never a URL, a password, a host or a database name. Never traces the shell.
set -eu

DIR=/run/crewflow/db-target
TARGET="$DIR/target.json"
PASSWORD_FILE="$DIR/owner-password"

refuse() {
  echo "db-setup: REFUSED - $1" >&2
  exit "${2:-64}"
}

# One run per setup volume, held by the KERNEL (security re-review R1/R2): fd 9 on the volume's .db-setup.flock, `flock -n`
# before anything else. The bootstrap child inherits fd 9; the kernel releases the lock when the last holder dies, however
# it dies (SIGKILL, OOM, reboot), so a killed run never blocks the next one and two runs never overlap.
FLOCK_FILE="$DIR/.db-setup.flock"
if [ -L "$FLOCK_FILE" ]; then
  refuse 'the run lock file in the setup volume is a symlink.' 70
fi
exec 9>>"$FLOCK_FILE"
if ! flock -n 9; then
  refuse 'another db-setup is running on this setup volume; nothing was changed. Start again when it has finished.' 70
fi
export CREWFLOW_DB_SETUP_FLOCK_FD=9

if [ "$#" -ne 0 ]; then
  refuse 'db-setup.sh takes no arguments.'
fi
if [ -n "${PG_DATABASE_PASSWORD:-}" ]; then
  refuse 'PG_DATABASE_PASSWORD must never reach a container: compose builds the admin URL from it.'
fi
if [ -n "${APP_SECRET:-}" ]; then
  refuse 'APP_SECRET must never reach db-setup: it is never part of a database credential (the crewflow_owner password is a random value in the password file).'
fi
# The three modes (header). Only presence is tested here, never a URL's contents: the bootstrap child decides the rest
# (exactly one URL; PG_DATABASE_URL must be crewflow_owner, PG_ADMIN_URL must not be; the retired name refused).
case "${CREWFLOW_BUNDLED_DB:-1}" in
  0 | 1) ;;
  *) refuse 'CREWFLOW_BUNDLED_DB must be exactly 0 (your own database) or 1 (the bundled db; unset = 1).' ;;
esac
if [ -z "${PG_ADMIN_URL:-}" ] && [ -z "${PG_DATABASE_URL:-}" ]; then
  # a. The bundled db: its superuser URL, built by compose from PG_DATABASE_PASSWORD (compose cannot require that value only
  # for the bundled db, so the requirement is checked here, and by the db service itself, at start: fail closed).
  if [ "${CREWFLOW_BUNDLED_DB:-1}" = 0 ]; then
    refuse 'CREWFLOW_BUNDLED_DB=0 (your own database) needs PG_ADMIN_URL (your admin URL: db-setup creates crewflow_owner) or PG_DATABASE_URL (the crewflow_owner URL you created yourself) in compose.env.'
  fi
  case "${CREWFLOW_BUNDLED_DB_ADMIN_URL:-}" in
    '') refuse 'the bundled database URL is missing from this service definition (CREWFLOW_BUNDLED_DB_ADMIN_URL); use the committed compose file.' ;;
    postgresql://postgres:@*) refuse 'PG_DATABASE_PASSWORD is required for the bundled database (compose.env; openssl rand -hex 32). With your own database set CREWFLOW_BUNDLED_DB=0 and PG_ADMIN_URL or PG_DATABASE_URL instead.' ;;
  esac
  PG_ADMIN_URL="$CREWFLOW_BUNDLED_DB_ADMIN_URL"
  export PG_ADMIN_URL
fi
# BEGIN crewflow wait-for-db
# Twenty's Helm wait-for-db init container, re-implemented (not copied): db-setup no longer has `depends_on: db`, because with
# CREWFLOW_BUNDLED_DB=0 the bundled db has no container and a platform that does not skip a 0-replica dependency (OpenShip:
# 'Dependency "db" has no container for service_healthy') then never starts db-setup. Instead db-setup waits for the database
# it will use: the bundled db (host db, mode a), or the host of PG_ADMIN_URL (mode b) or PG_DATABASE_URL (mode c). The probe
# is pg_isready's check, in node (the image has no pg_isready): a TCP connect and a protocol-3.0 startup message with a FIXED
# placeholder login (crewflow_wait_for_db), no TLS and no password; an authentication request or any error other than 57P03
# (starting up / shutting down) means the server accepts connections. It never authenticates, never runs a query and reads
# nothing but the URL's host and port; the bootstrap child then makes the real verify-full connection. Bounded by
# CREWFLOW_DB_WAIT_SECONDS (unset or empty = 170; 0 = do not wait; at most 900) on the monotonic clock; a progress line
# whenever the result changes and every 10 s; on timeout ONE fixed line and exit 70 (a failure, like the bootstrap child's own
# "did not accept a connection" 70; 64 stays for settings the operator must change, such as an invalid
# CREWFLOW_DB_WAIT_SECONDS). The default 170 s stays inside OpenShip's 180 s window for a service_completed_successfully
# dependency without a health check (security review L1), so on a dead database db-setup fails with its own line first.
# Prints no URL, host, login, password or database name. Not waited for (the refusal or the child's check comes at once):
# a bad CREWFLOW_BUNDLED_DB, both URLs, neither with CREWFLOW_BUNDLED_DB=0, the bundled db without its password, an
# unparseable URL. In the compose wrapper ONLY those come before the wait: db-setup.sh's own preamble refusals (arguments,
# PG_DATABASE_PASSWORD or APP_SECRET present, the run lock) run after it (review L2). Safe to run twice: the same block
# runs in docker-compose.production.yml / docker-compose.image.yml (the
# published image's db-setup.sh has no wait) and again here (run-prestart-shell-tests.cjs and compose-owner-login.cjs
# require the copies to be identical).
crewflow_wait_for_db() {
  case "${CREWFLOW_BUNDLED_DB:-1}" in 0 | 1) ;; *) return 0 ;; esac
  if [ -n "${PG_ADMIN_URL:-}" ] && [ -n "${PG_DATABASE_URL:-}" ]; then return 0; fi
  crewflow_wait_url="${PG_ADMIN_URL:-${PG_DATABASE_URL:-}}"
  if [ -z "$crewflow_wait_url" ]; then
    if [ "${CREWFLOW_BUNDLED_DB:-1}" != 1 ]; then return 0; fi
    crewflow_wait_url="${CREWFLOW_BUNDLED_DB_ADMIN_URL:-}"
    case "$crewflow_wait_url" in '' | postgresql://postgres:@*) crewflow_wait_url=''; return 0 ;; esac
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
# After the refusals above (an invalid setting is refused at once, never waited for) and the kernel run lock, before the
# run-lock token and the bootstrap child: wait, bounded, until the database accepts connections.
crewflow_wait_for_db
# The bundled URL is never needed again (modes b and c ignore it); the child reads PG_ADMIN_URL / PG_DATABASE_URL only.
unset CREWFLOW_BUNDLED_DB_ADMIN_URL
# The run lock's token: 32 hex characters, never printed. The child records it in .db-setup.lock/owner.
LOCK="$DIR/.db-setup.lock"
LOCK_TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
case "$LOCK_TOKEN" in
  ????????????????????????????????) ;;
  *) refuse 'could not read 16 random bytes for the run lock.' 70 ;;
esac
export CREWFLOW_DB_SETUP_LOCK_TOKEN="$LOCK_TOKEN"
lock_is_ours() {
  [ -d "$LOCK" ] && [ ! -L "$LOCK" ] && [ -f "$LOCK/owner" ] && [ ! -L "$LOCK/owner" ] && grep -qF "\"token\":\"$LOCK_TOKEN\"" "$LOCK/owner"
}
release_lock() {
  if lock_is_ours; then
    rm -f "$LOCK/owner"
    rmdir "$LOCK" 2>/dev/null || true
  fi
}
trap release_lock EXIT
# Temp files a killed earlier run may have left (owner-password-file.ts / db-target-file.ts name them
# .<file>.<pid>.<random>.tmp; `.owner-password.*.tmp` also covers the pending `.owner-password.next.*.tmp`). Removed only
# while THIS run holds the lock (a concurrent run's in-flight files are never touched). The pending owner-password.next is
# NOT removed here: the bootstrap child settles it.
clean_after_failure() {
  if lock_is_ours; then
    rm -f "$TARGET" "$DIR"/.owner-password.*.tmp "$DIR"/.target.json.*.tmp
  fi
}
export CREWFLOW_DB_TARGET_FILE="$TARGET"

# BEGIN crewflow bundled-db CA
# $1: the database URL this process connects with (db-setup: PG_ADMIN_URL or PG_DATABASE_URL; rab-api / rab-worker: the
# crewflow_owner URL they built). Only its host is read.
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
crewflow_bundled_db_ca "${PG_ADMIN_URL:-${PG_DATABASE_URL:-}}"

STATUS=0
# The child runs in the background so a stop (TERM/INT to this PID 1) reaches it, and this script still exits through its
# EXIT trap (the lock directory is released; the kernel lock goes with the processes).
node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js &
CHILD=$!
trap 'kill -TERM "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null; exit 143' TERM INT
wait "$CHILD" || STATUS=$?
trap - TERM INT
case "$STATUS" in
  0) ;;
  64) clean_after_failure; refuse 'the database setup step refused (see the [owner-bootstrap] line above).' 64 ;;
  *) clean_after_failure; refuse "the database setup step failed (see the [owner-bootstrap] lines above; exit $STATUS)." "$STATUS" ;;
esac
if [ ! -s "$TARGET" ]; then
  refuse 'the database setup step reported success but wrote no target file; rab-api and rab-worker cannot start.' 70
fi
if [ ! -s "$PASSWORD_FILE" ]; then
  clean_after_failure
  refuse 'the database setup step reported success but no crewflow_owner password file exists; rab-api and rab-worker cannot start.' 70
fi
echo 'db-setup: done (crewflow_owner ready, database target file written)'
