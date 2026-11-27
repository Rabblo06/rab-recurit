#!/usr/bin/env bash
# Lane F: disposable PG16.16 + Redis 7 on ibox2, every resource named crewtest-lanef-*, data under /data/crewtest-lanef only.
set -euo pipefail
W=/data/crewtest-lanef
mkdir -p $W/secrets $W/pgdata $W/redis
umask 077
[ -s $W/secrets/su ] || openssl rand -hex 24 > $W/secrets/su
[ -s $W/secrets/owner ] || openssl rand -hex 32 > $W/secrets/owner
[ -s $W/secrets/app_secret ] || openssl rand -hex 32 > $W/secrets/app_secret
chmod 644 $W/secrets/su   # read by the container's postgres user via POSTGRES_PASSWORD_FILE
LOGOPT=(--log-driver json-file --log-opt max-size=1m --log-opt max-file=1)
docker run -d --name crewtest-lanef-pg "${LOGOPT[@]}" -p 127.0.0.1:15490:5432 \
  --memory 1024m --cpus 2 --shm-size 256m \
  -v $W/pgdata:/var/lib/postgresql/data -v $W/secrets/su:/run/lanef/su:ro \
  -e POSTGRES_USER=lanef_admin -e POSTGRES_PASSWORD_FILE=/run/lanef/su -e POSTGRES_DB=crewflow \
  -e POSTGRES_INITDB_ARGS="--auth-local=scram-sha-256 --auth-host=scram-sha-256 --data-checksums" \
  postgres:16 postgres -c password_encryption=scram-sha-256 -c shared_preload_libraries=pg_stat_statements \
  -c pg_stat_statements.track=top -c pg_stat_statements.max=5000 -c track_io_timing=on -c crewflow.disposable_cluster=on >/dev/null
docker run -d --name crewtest-lanef-redis "${LOGOPT[@]}" -p 127.0.0.1:16490:6379 --memory 512m \
  -v $W/redis:/data redis:7-alpine redis-server --appendonly yes --maxmemory-policy noeviction >/dev/null
for i in $(seq 1 90); do docker exec crewtest-lanef-pg pg_isready -h 127.0.0.1 -U lanef_admin -d crewflow >/dev/null 2>&1 && break; sleep 1; done
docker exec crewtest-lanef-pg pg_isready -h 127.0.0.1 -U lanef_admin -d crewflow
docker exec crewtest-lanef-redis redis-cli ping
echo DB_UP
