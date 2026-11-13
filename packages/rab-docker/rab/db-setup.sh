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
#     stored password that does not log in is refused (64: delete the password file and start again with the admin
#     address); a lost password file + the admin URL resets the password once (a Crewflow addition): the new password is
#     stored first as owner-password.next and becomes owner-password only after the COMMIT and a login with it;
#   - existing crewflow_owner URL: read-only checks only; its password is copied into the password file; the database is
#     never written to and the password never changed.
# In every mode it then writes the CREDENTIAL-FREE target file /run/crewflow/db-target/target.json
# ({"v":1,"host","port","database","params"}: no user, no password; temp file + rename, mode 0644). Both files live on a
# small named volume that rab-api and rab-worker mount read-only; they never see PG_DATABASE_URL.
# One run per volume (security re-check F1, R1/R2): this script first takes the kernel lock (flock -n on fd 9, the
# volume's .db-setup.flock; a second run stops with exit 70); the bootstrap child inherits it and also takes the lock
# directory .db-setup.lock with this script's token (CREWFLOW_DB_SETUP_LOCK_TOKEN), and only then removes the previous
# target file and the temp files a killed run left. This script releases the directory on exit, only when the owner token
# in it is its own; the kernel releases the flock however the processes end. The password file is
# never removed here (it is the credential of an existing role). Exit 0 = done; 64 = refusal;
# anything else = failure (rab-api is not started: depends_on service_completed_successfully, and its own bounded wait).
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
if [ -z "${PG_DATABASE_URL:-}" ]; then
  refuse 'PG_DATABASE_URL is required: the database admin URL, or an existing crewflow_owner URL (the bundled db by default).'
fi
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
