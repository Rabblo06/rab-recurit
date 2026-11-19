#!/usr/bin/env bash
# TEST-ONLY (owner decisions 2026-11-19: provider-neutral db-setup, option 1 "Create login, you set password"): the
# disposable docker setup for bootstrap-owner-login-fallback-check.ts. Runs in CI (ci-deployment-owner-login.yaml, job
# db-setup-capability) and on the owner's laptop within the local test rules (one PostgreSQL at a time, memory-capped):
#
#   run-fallback-check.sh <repo checkout with node_modules> <empty work dir>
#
# Settings (environment; defaults in brackets):
#   FBC_PG_IMAGE     the Debian PostgreSQL 16 image [the repo's pinned bundled-db image, by digest]
#   FBC_PREFIX       container / network name prefix [fbc-]  (the laptop uses crewtest-<agent>-)
#   FBC_PG_MEM       memory cap of each PostgreSQL / build container [384m]
#   FBC_PGB_MEM      memory cap of PgBouncer [64m]
#   FBC_NODE_HEAP    V8 heap cap (MB) of the harness and of each child it starts [256]
#   FBC_PORT_BASE    first host port, published on 127.0.0.1 only [47440]
#
# One PostgreSQL runs at a time. Groups, each from a fresh container:
#   plain  PostgreSQL 16 with TLS (a per-run CA; server certificate for IP 127.0.0.1): P1, P2, Q1, H1; then PgBouncer (transaction
#          pooling, defaults) in front of it: B1; then PgBouncer with ignore_startup_parameters=options: B2, B3
#   sim    the same + refuse_prehashed.c (refuses pre-hashed role passwords at COMMIT, XX000, and, when switched on, any
#          role without a password), EVERY statement logged with its parameters: N1, N2
#   trust  a pg_hba that TRUSTS crewflow_owner (and only it): T1
# The extension and PgBouncer are built / unpacked in a throwaway container of the same image (apt; nothing installed on the
# host). Every container and the network are removed by exact name afterwards; nothing is pruned. Secrets are generated here
# and never printed.
set -euo pipefail
REPO="$(cd "$1" && pwd)"
W="$2"
HERE="$REPO/packages/rab-server/src/database/typeorm/scripts/owner-login/fallback-check"
mkdir -p "$W"
W="$(cd "$W" && pwd)"
PG_IMAGE="${FBC_PG_IMAGE:-postgres@sha256:dd2bf3ce2dc83a81674cf7f217fcfd8a5009a4b325dda5b843bfee82a06cff6f}"
P="${FBC_PREFIX:-fbc-}"
PG_MEM="${FBC_PG_MEM:-384m}"
PGB_MEM="${FBC_PGB_MEM:-64m}"
HEAP="${FBC_NODE_HEAP:-256}"
PORT="${FBC_PORT_BASE:-47440}"
NET="${P}net"
PG_NAME="${P}pg"
PGB_NAME="${P}pgbouncer"
BUILD_NAME="${P}build"
# Docker Desktop on Windows: a path argument must reach docker unmangled.
export MSYS_NO_PATHCONV=1
dockerpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
WD="$(dockerpath "$W")"
HD="$(dockerpath "$HERE")"

STATUS=0
cleanup() {
  docker rm -f "$PG_NAME" "$PGB_NAME" "$BUILD_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # Files the build container wrote are handed back to this user (below); if a run stopped before that, remove them through
  # a throwaway container of the same image (they belong to its root), never with sudo.
  if ! rm -rf "$W/certs" "$W/pgb" "$W/ext" "$W/pgbroot" "$W/hba" 2>/dev/null; then
    docker run --rm --name "${P}clean" --memory=64m -v "$WD:/w" --entrypoint rm "$PG_IMAGE" -rf /w/certs /w/pgb /w/ext /w/pgbroot /w/hba >/dev/null 2>&1 || true
    rm -rf "$W/certs" "$W/pgb" "$W/ext" "$W/pgbroot" "$W/hba"
  fi
}
trap cleanup EXIT
cleanup

# A per-run CA and a server certificate for 127.0.0.1 (pg-tls.ts binds the name check of an IP host to that IP).
mkdir -p "$W/certs" "$W/ext" "$W/pgbroot" "$W/hba" "$W/pgb"
(
  cd "$W/certs"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=fbc-test-ca 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=127.0.0.1 2>/dev/null
  printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\n' > san.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile san.ext 2>/dev/null
  chmod 644 server.key server.crt ca.crt
)
printf 'local all all trust\nhostssl all crewflow_owner 0.0.0.0/0 trust\nhost all crewflow_owner 0.0.0.0/0 trust\nhost all all 0.0.0.0/0 scram-sha-256\nhost all all ::0/0 scram-sha-256\n' > "$W/hba/pg_hba.conf"

# The test extension and PgBouncer, built / unpacked in a throwaway container of the same image (pgdg apt packages).
docker run --rm --name "$BUILD_NAME" --memory="$PG_MEM" --memory-swap="$PG_MEM" -e HOST_IDS="$(id -u):$(id -g)" \
  -v "$HD/refuse_prehashed.c:/src/refuse_prehashed.c:ro" -v "$WD/ext:/out" -v "$WD/pgbroot:/pgb" --entrypoint bash "$PG_IMAGE" -c '
  set -e
  major="$(pg_config --version | sed -E "s/^PostgreSQL ([0-9]+).*/\1/")"
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq --no-install-recommends gcc libc6-dev >/dev/null 2>&1
  # The server headers only (the -dev package is unpacked, not installed: its llvm dependencies are not needed).
  mkdir -p /tmp/deb /tmp/dev && cd /tmp/deb
  apt-get download "postgresql-server-dev-$major" pgbouncer libevent-2.1-7t64 libcares2 >/dev/null 2>&1
  dpkg -x /tmp/deb/postgresql-server-dev-*.deb /tmp/dev
  gcc -O2 -fPIC -shared -I"/tmp/dev/usr/include/postgresql/$major/server" -o /out/refuse_prehashed.so /src/refuse_prehashed.c
  for deb in /tmp/deb/pgbouncer_*.deb /tmp/deb/libevent-*.deb /tmp/deb/libcares2_*.deb; do dpkg -x "$deb" /pgb; done
  chmod -R a+rX /out /pgb
  # Hand the files back to the user running this script (the CI runner), so its own cleanup can remove them.
  chown -R "$HOST_IDS" /out /pgb 2>/dev/null || true'
docker network create "$NET" >/dev/null
SUPW="$(openssl rand -hex 24)"
PGPORT=$((PORT + 1))
PGBPORT=$((PORT + 2))

start_pg() { # extra postgres args...
  docker run -d --name "$PG_NAME" --network "$NET" --network-alias fbc-pg --memory="$PG_MEM" --memory-swap="$PG_MEM" \
    -p "127.0.0.1:$PGPORT:5432" -e POSTGRES_PASSWORD="$SUPW" \
    -v "$WD/ext/refuse_prehashed.so:/opt/fbc/refuse_prehashed.so:ro" \
    -v "$WD/certs:/certs:ro" -v "$WD/hba:/hba:ro" --entrypoint bash "$PG_IMAGE" -c \
    "cp /opt/fbc/refuse_prehashed.so \"\$(pg_config --pkglibdir)/\" && cp /certs/server.crt /certs/server.key /tmp/ && chown postgres /tmp/server.crt /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key $*" >/dev/null
  for _ in $(seq 1 90); do
    if docker exec "$PG_NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then sleep 2; return 0; fi
    sleep 1
  done
  echo "[fallback-check] FAIL | $PG_NAME did not start"
  return 1
}
stop_pg() { docker rm -f "$PG_NAME" >/dev/null 2>&1 || true; }
start_pgbouncer() { # 1 = defaults, 2 = ignore_startup_parameters=options
  printf '"postgres" "%s"\n' "$SUPW" > "$W/pgb/userlist.txt"
  {
    printf '[databases]\n* = host=fbc-pg port=5432\n[pgbouncer]\nlisten_addr = 0.0.0.0\nlisten_port = 6432\nunix_socket_dir =\n'
    printf 'auth_type = scram-sha-256\nauth_file = /etc/pgb/userlist.txt\nauth_user = postgres\n'
    printf 'auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename=$1\npool_mode = transaction\ndefault_pool_size = 1\n'
    if [ "$1" = 2 ]; then printf 'ignore_startup_parameters = options,extra_float_digits\n'; fi
  } > "$W/pgb/pgbouncer.ini"
  docker run -d --name "$PGB_NAME" --network "$NET" --memory="$PGB_MEM" --memory-swap="$PGB_MEM" -p "127.0.0.1:$PGBPORT:6432" \
    -u postgres -v "$WD/pgb:/etc/pgb:ro" -v "$WD/pgbroot:/pgb:ro" -e LD_LIBRARY_PATH=/pgb/usr/lib/x86_64-linux-gnu \
    --entrypoint /pgb/usr/sbin/pgbouncer "$PG_IMAGE" /etc/pgb/pgbouncer.ini >/dev/null
  sleep 2
}
stop_pgbouncer() { docker rm -f "$PGB_NAME" >/dev/null 2>&1 || true; rm -f "$W/pgb/userlist.txt"; }

harness() { # env assignments... -- scenario prefixes...
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  set +e
  (cd "$REPO" && env PG_SSL_CA_CERT_PATH="$WD/certs/ca.crt" FBC_CHILD_HEAP="$HEAP" "${envs[@]}" \
    node --max-old-space-size="$HEAP" node_modules/ts-node/dist/bin.js --transpile-only -P packages/rab-server/tsconfig.app.json \
    "$HD/bootstrap-owner-login-fallback-check.ts" "$@")
  local rc=$?
  set -e
  if [ "$rc" != 0 ]; then STATUS=1; fi
}
SU="postgresql://postgres:$SUPW@127.0.0.1:$PGPORT/postgres"

# plain: P1, P2, then B1 (PgBouncer defaults), then B2 / B3 (options ignored).
start_pg
harness FBC_PLAIN_SU_URL="$SU" -- P1 P2 Q1 H1
start_pgbouncer 1
harness FBC_PLAIN_SU_URL="$SU" FBC_BOUNCER1_HOSTPORT="127.0.0.1:$PGBPORT" -- B1
stop_pgbouncer
start_pgbouncer 2
harness FBC_PLAIN_SU_URL="$SU" FBC_BOUNCER2_HOSTPORT="127.0.0.1:$PGBPORT" -- B2 B3
stop_pgbouncer
stop_pg

# sim: N1, N2 (every statement logged with its parameters).
start_pg -c shared_preload_libraries=refuse_prehashed,pg_stat_statements -c pg_stat_statements.track=all -c log_statement=all -c log_min_duration_statement=0
harness FBC_SIM_SU_URL="$SU" FBC_SIM_CONTAINER="$PG_NAME" -- N1 N2
refusals="$(docker logs "$PG_NAME" 2>&1 | grep -c 'simulated refusal: role passwords must be supplied in plain text' || true)"
echo "[fallback-check] simulator refusals of a pre-hashed password in the server log: $refusals"
if [ "$refusals" -lt 1 ]; then echo '[fallback-check] FAIL | the simulator never refused (vacuous run)'; STATUS=1; fi
if docker logs "$PG_NAME" 2>&1 | grep -qF "$SUPW"; then echo '[fallback-check] FAIL | the superuser password appears in the server log'; STATUS=1; fi
stop_pg

# trust: T1 (pg_hba trusts crewflow_owner).
start_pg -c hba_file=/hba/pg_hba.conf
harness FBC_TRUST_SU_URL="$SU" -- T1
stop_pg

if [ "$STATUS" = 0 ]; then echo '[fallback-check] ALL GROUPS PASS'; else echo '[fallback-check] SOME GROUPS FAILED'; fi
exit "$STATUS"
