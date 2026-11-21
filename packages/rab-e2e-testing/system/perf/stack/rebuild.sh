#!/usr/bin/env bash
# Rebuild the disposable database from nothing (owner-login install, exactly as production's first start) and seed it.
set -uo pipefail
W=/data/crewtest-lanef
. $W/env.sh; . $W/prodenv.sh
cd $W/rab
red() { sed -E 's#(postgres(ql)?|redis)://[^ "]+#<url>#g'; }
P=$W/psql.sh
for f in api worker sinks; do [ -f $W/$f.pid ] && kill "$(cat $W/$f.pid)" 2>/dev/null; done; sleep 3
# A fresh cluster (roles are cluster-wide, so a fresh install needs a fresh cluster) and a fresh Redis: this run's own
# containers and data directories only, removed by exact name.
docker rm -f crewtest-lanef-pg crewtest-lanef-redis >/dev/null 2>&1
sudo rm -rf $W/pgdata $W/redis
bash $W/db-up.sh | tail -1
bash $W/tls.sh | tail -1
echo "== install"; t0=$(date +%s)
env -i PATH="$PATH" HOME=$HOME TMPDIR=$TMPDIR NODE_ENV=production PG_ADMIN_URL="$LF_ADMIN_URL" PG_DATABASE_URL="$LF_OWNER_URL" PG_SSL_CA_CERT_PATH="$PG_SSL_CA_CERT_PATH" \
  node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js 2>&1 | red | grep RESULT
lf_prod_env CREWFLOW_MIGRATE_ON_START=true CREWFLOW_MIGRATION_APPROVAL_MODE=none node packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js > $W/logs/migrate.log 2>&1; echo "migrate rc=$?"
for a in "" --harden; do env -i PATH="$PATH" HOME=$HOME TMPDIR=$TMPDIR NODE_ENV=production PG_ADMIN_URL="$LF_ADMIN_URL" PG_DATABASE_URL="$LF_OWNER_URL" PG_SSL_CA_CERT_PATH="$PG_SSL_CA_CERT_PATH" \
  node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js $a 2>&1 | red | grep RESULT; done
echo "install $(( $(date +%s)-t0 ))s"
lf_prod_env node packages/rab-worker/dist/register-schedulers.js 2>&1 | red | grep -o "[0-9]* Crewflow job scheduler(s) registered"
echo "== fixture seed"
bash $P -q -c "ALTER DATABASE crewflow SET crewflow.disposable_test_database = true"
rm -rf $W/seed; mkdir -p $W/seed
env -i PATH="$PATH" HOME=$HOME TMPDIR=$TMPDIR NODE_ENV=test HWS_RUNTIME_ENABLED=false REDIS_URL=redis://127.0.0.1:16490/3 E2E_LIVE_OUT=$W/seed \
  TEST_DATABASE_URL="$LF_OWNER_URL" TEST_DATABASE_ADMIN_URL="$LF_ADMIN_URL" PG_SSL_CA_CERT_PATH="$PG_SSL_CA_CERT_PATH" NODE_EXTRA_CA_CERTS="$PG_SSL_CA_CERT_PATH" APP_SECRET="$LF_APP_SECRET" \
  node node_modules/ts-node/dist/bin.js --transpile-only -P packages/rab-server/tsconfig.spec.json packages/rab-e2e-testing/live/seed-live-e2e.ts 2>&1 | red | grep "e2e-live-seed"
cp $W/seed-volume.mjs packages/rab-e2e-testing/system/perf/seed-volume.mjs
PERF_ADMIN_URL="$LF_ADMIN_URL" PERF_PG_CA="$PG_SSL_CA_CERT_PATH" node packages/rab-e2e-testing/system/perf/seed-volume.mjs --staff 5000 --shifts 47250 --live-bookings 0 --pending-offers 0 --out $W/seed/volume-full.json 2>&1 | red | grep -v '^\s*at '
bash $P -q -c "ALTER DATABASE crewflow RESET crewflow.disposable_test_database"
bash $P -q -c "ALTER DATABASE crewflow SET crewflow.disposable_test_database = false" -c "ALTER DATABASE crewflow RESET crewflow.disposable_test_database"
# Placeholder objects the historical statements / timesheets point at.
mkdir -p $W/sinkdata/s3/crewtest-lanef/production/perf
printf '%%PDF-1.4\n%%placeholder\n' | tee $W/sinkdata/s3/crewtest-lanef/production/perf/statement-placeholder.pdf > $W/sinkdata/s3/crewtest-lanef/production/perf/timesheet-placeholder.pdf
df -h /data | tail -1
echo REBUILD_DONE
