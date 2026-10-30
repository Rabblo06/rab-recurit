#!/bin/sh
# RETIRED AS A MIGRATING ENTRYPOINT (Phase B P7). This script used to run setup-db.js and bootstrap-admin before main.js on
# every API start. The API never migrates now: migrations run only in the one-off `rab-migrate` process
# (deploy-prepare.js) with the migration-only credential, and the first Platform Admin is bootstrapped by the explicit
# `bootstrap-admin` command run as its own job. Kept only so anything that still starts `./start.sh` gets the current API
# start (api-prestart.sh: refuse migration credentials, read-only pending-migration check as the runtime role, exec
# main.js) instead of a migration. It never migrates and never falls back to doing so.
set -eu
HERE="$(dirname "$0")"
if [ ! -f "$HERE/api-prestart.sh" ]; then
  echo "start.sh: REFUSED - api-prestart.sh is not in the image next to start.sh; the API will not start (it never migrates)." >&2
  exit 64
fi
exec /bin/sh "$HERE/api-prestart.sh"
