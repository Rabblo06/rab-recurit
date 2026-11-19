#!/usr/bin/env bash
# TEST-ONLY (owner decision 2026-11-19, provider-neutral db-setup): the disposable docker setup for
# bootstrap-owner-login-fallback-check.ts. Run on a docker host that is NOT a production machine (InstaBox), Debian 13 with
# gcc and dpkg-deb:
#
#   run-fallback-check.sh <repo checkout with node_modules> <empty work dir> [scenario prefix...]
#
# It starts, on a private docker network, with ports published on 127.0.0.1 only, all from the stock postgres:16 image:
#   fbc-plain     PostgreSQL 16, TLS on (a per-run CA; server certificate for IP 127.0.0.1)
#   fbc-sim       the same + refuse_prehashed.c: refuses pre-hashed role passwords at COMMIT (XX000) and, when switched on
#                 (refuse_prehashed.refuse_passwordless_login, SIGHUP), a LOGIN role created without a password; EVERY
#                 statement logged with its parameters (log_statement=all, log_min_duration_statement=0)
#   fbc-bouncer1  PgBouncer, transaction pooling, defaults (refuses the `options` startup parameter)
#   fbc-bouncer2  PgBouncer, transaction pooling, ignore_startup_parameters=options, one server connection per pool
# No image is built (the docker host's root disk stays untouched): the server headers and PgBouncer come from the same pgdg
# apt repository as the image, DOWNLOADED (not installed) into the work dir by a throwaway container whose apt state also
# lives there; the extension is compiled on the host against those headers and bind-mounted into the stock image; PgBouncer
# runs from its extracted package inside the stock image. Every data directory is in the work dir. Afterwards every
# container, the network and the work dir's secrets are removed. Secrets are generated here and never printed.
set -euo pipefail
REPO="$(cd "$1" && pwd)"
W="$2"
shift 2
HERE="$REPO/packages/rab-server/src/database/typeorm/scripts/owner-login/fallback-check"
mkdir -p "$W"
W="$(cd "$W" && pwd)"
NET=fbc-net
PG_IMAGE="${FBC_PG_IMAGE:-postgres:16}"
cleanup() {
  docker rm -f fbc-plain fbc-sim fbc-bouncer1 fbc-bouncer2 >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # The data directories belong to the containers' postgres user: removed from inside a container.
  docker run --rm -v "$W:/w" "$PG_IMAGE" bash -c 'rm -rf /w/data-fbc-plain /w/data-fbc-sim' >/dev/null 2>&1 || true
  rm -rf "$W/certs" "$W/pgb1" "$W/pgb2" "$W/dl" "$W/root" "$W/pgbroot" "$W/ext"
}
trap cleanup EXIT
cleanup

# A per-run CA and a server certificate for 127.0.0.1 (pg-tls.ts binds the name check of an IP host to that IP).
mkdir -p "$W/certs"
(
  cd "$W/certs"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=fbc-test-ca 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=127.0.0.1 2>/dev/null
  printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\n' > san.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile san.ext 2>/dev/null
  chmod 644 server.key server.crt ca.crt
)

mkdir -p "$W/dl/lists/partial" "$W/dl/cache/archives/partial" "$W/dl/debs" "$W/root" "$W/pgbroot" "$W/ext"
docker run --rm -v "$W/dl:/w" "$PG_IMAGE" bash -c '
  set -e
  A="-o Dir::State::Lists=/w/lists -o Dir::Cache=/w/cache"
  apt-get -qq $A update >/dev/null 2>&1
  cd /w/debs
  apt-get -qq $A download postgresql-server-dev-16 pgbouncer libevent-2.1-7t64 libcares2 >/dev/null 2>&1
  chmod -R a+rwX /w' >/dev/null
for deb in "$W"/dl/debs/postgresql-server-dev-16_*.deb; do dpkg-deb -x "$deb" "$W/root"; done
for deb in "$W"/dl/debs/pgbouncer_*.deb "$W"/dl/debs/libevent-2.1-7t64_*.deb "$W"/dl/debs/libcares2_*.deb; do dpkg-deb -x "$deb" "$W/pgbroot"; done
gcc -O2 -fPIC -shared -I"$W/root/usr/include/postgresql/16/server" -o "$W/ext/refuse_prehashed.so" "$HERE/refuse_prehashed.c"
chmod 755 "$W/ext/refuse_prehashed.so"

docker network create "$NET" >/dev/null
SUPW="$(openssl rand -hex 24)"
start_pg() { # name port extra-args...
  local name="$1" port="$2"
  shift 2
  mkdir -p "$W/data-$name"
  docker run -d --name "$name" --network "$NET" -p "127.0.0.1:$port:5432" -e POSTGRES_PASSWORD="$SUPW" \
    -e PGDATA=/data/pgdata -v "$W/data-$name:/data" \
    -v "$W/ext/refuse_prehashed.so:/usr/lib/postgresql/16/lib/refuse_prehashed.so:ro" \
    -v "$W/certs:/certs:ro" --entrypoint bash "$PG_IMAGE" -c \
    "cp /certs/server.crt /certs/server.key /tmp/ && chown postgres /tmp/server.crt /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key $*" >/dev/null
}
start_pg fbc-plain 55441
start_pg fbc-sim 55442 -c shared_preload_libraries=refuse_prehashed -c log_statement=all -c log_min_duration_statement=0
for name in fbc-plain fbc-sim; do
  ready=no
  for _ in $(seq 1 90); do
    if docker exec "$name" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then ready=yes; break; fi
    sleep 1
  done
  if [ "$ready" != yes ]; then echo "[fallback-check] FAIL | $name did not start"; exit 1; fi
done
sleep 2

for n in 1 2; do
  mkdir -p "$W/pgb$n"
  printf '"postgres" "%s"\n' "$SUPW" > "$W/pgb$n/userlist.txt"
  {
    printf '[databases]\n* = host=fbc-plain port=5432\n[pgbouncer]\nlisten_addr = 0.0.0.0\nlisten_port = 6432\nunix_socket_dir =\n'
    printf 'auth_type = scram-sha-256\nauth_file = /etc/pgb/userlist.txt\nauth_user = postgres\n'
    printf 'auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename=$1\npool_mode = transaction\ndefault_pool_size = 1\n'
    if [ "$n" = 2 ]; then printf 'ignore_startup_parameters = options,extra_float_digits\n'; fi
  } > "$W/pgb$n/pgbouncer.ini"
  chmod 644 "$W/pgb$n/userlist.txt" "$W/pgb$n/pgbouncer.ini"
  docker run -d --name "fbc-bouncer$n" --network "$NET" -p "127.0.0.1:5643$n:6432" -u postgres -v "$W/pgb$n:/etc/pgb:ro" \
    -v "$W/pgbroot:/pgb:ro" -e LD_LIBRARY_PATH=/pgb/usr/lib/x86_64-linux-gnu \
    --entrypoint /pgb/usr/sbin/pgbouncer "$PG_IMAGE" /etc/pgb/pgbouncer.ini >/dev/null
done
sleep 2

cd "$REPO"
set +e
PG_SSL_CA_CERT_PATH="$W/certs/ca.crt" \
  FBC_PLAIN_SU_URL="postgresql://postgres:$SUPW@127.0.0.1:55441/postgres" \
  FBC_SIM_SU_URL="postgresql://postgres:$SUPW@127.0.0.1:55442/postgres" \
  FBC_BOUNCER1_HOSTPORT=127.0.0.1:56431 \
  FBC_BOUNCER2_HOSTPORT=127.0.0.1:56432 \
  FBC_SIM_CONTAINER=fbc-sim FBC_PLAIN_CONTAINER=fbc-plain \
  node node_modules/ts-node/dist/bin.js --transpile-only -P packages/rab-server/tsconfig.app.json \
  "$HERE/bootstrap-owner-login-fallback-check.ts" "$@"
STATUS=$?
set -e
# The server log of the refusing server must not hold the superuser password either (it never travels as text), and it
# must show that the simulator really refused (the scenarios are vacuous otherwise).
if docker logs fbc-sim 2>&1 | grep -qF "$SUPW"; then echo '[fallback-check] FAIL | the superuser password appears in the server log'; STATUS=1; fi
refusals="$(docker logs fbc-sim 2>&1 | grep -c 'simulated refusal: role passwords must be supplied in plain text' || true)"
echo "[fallback-check] simulator refusals in the server log: $refusals"
if [ "$refusals" -lt 1 ]; then echo '[fallback-check] FAIL | the simulator never refused (vacuous run)'; STATUS=1; fi
exit "$STATUS"
