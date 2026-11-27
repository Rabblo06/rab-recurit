#!/usr/bin/env bash
# Start the API in production mode on the disposable stack (2 cores, 768 MiB heap, pool 10).
set -uo pipefail
. /data/crewtest-lanef/env.sh; . /data/crewtest-lanef/prodenv.sh
cd /data/crewtest-lanef/rab
[ -f ../api.pid ] && kill "$(cat ../api.pid)" 2>/dev/null
for i in $(seq 1 40); do curl -s -o /dev/null --max-time 1 http://127.0.0.1:3490/healthz || break; sleep 1; done
# The pid file holds the node process itself (bash execs taskset, taskset execs node).
lf_prod_env PORT=3490 PG_POOL_MAX_CONNECTIONS=10 NODE_OPTIONS=--max-old-space-size=768 \
  nohup bash -c 'echo $$ > /data/crewtest-lanef/api.pid; exec taskset -c 0,1 node packages/rab-server/dist/main.js' > ../logs/api.log 2>&1 &
for i in $(seq 1 120); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:3490/healthz && break; sleep 1; done
curl -s --max-time 3 http://127.0.0.1:3490/healthz | head -c 80; echo
