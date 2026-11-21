#!/usr/bin/env bash
# Start the Worker in production mode on the disposable stack (pool 12, production worker environment).
set -uo pipefail
. /data/crewtest-lanef/env.sh; . /data/crewtest-lanef/prodenv.sh
cd /data/crewtest-lanef/rab
mkdir -p ../tmp/jobs ../health
[ -f ../worker.pid ] && kill "$(cat ../worker.pid)" 2>/dev/null; sleep 2
lf_prod_env PG_POOL_MAX_CONNECTIONS=12 DISABLE_DB_MIGRATIONS=true DISABLE_CRON_JOBS_REGISTRATION=true CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS=0 \
  WORKSPACE_PROVISIONER_INTERVAL_SECONDS=5 CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS=120 WORKER_SHUTDOWN_TIMEOUT_MS=30000 \
  CREWFLOW_INSTANCE_HEALTH_FILE=/data/crewtest-lanef/health/heartbeat.json XDG_CONFIG_HOME=/data/crewtest-lanef/tmp/jobs/.config XDG_CACHE_HOME=/data/crewtest-lanef/tmp/jobs/.cache \
  NODE_OPTIONS=--max-old-space-size=1152 nohup bash -c 'echo $$ > /data/crewtest-lanef/worker.pid; exec taskset -c 2,3 node packages/rab-worker/dist/main.js' > ../logs/worker.log 2>&1 &
sleep 20
kill -0 "$(cat ../worker.pid)" && echo WORKER_RUNNING
sed -E 's#(postgres(ql)?|redis)://[^ "]+#<url>#g' ../logs/worker.log | grep -iE "refus|fatal|rab-worker ready" | head -4
