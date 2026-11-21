#!/usr/bin/env bash
# Start sinks, API and Worker (production mode) on the rebuilt database.
set -uo pipefail
W=/data/crewtest-lanef
. $W/env.sh
cp $W/sinks.mjs $W/rab/packages/rab-e2e-testing/system/perf/sinks.mjs
mkdir -p $W/sinkdata
[ -f $W/sinks.pid ] && kill "$(cat $W/sinks.pid)" 2>/dev/null; sleep 1
nohup bash -c 'echo $$ > /data/crewtest-lanef/sinks.pid; exec taskset -c 3 node /data/crewtest-lanef/rab/packages/rab-e2e-testing/system/perf/sinks.mjs /data/crewtest-lanef/sinkdata 19000 2525' > $W/logs/sinks.log 2>&1 &
sleep 1
bash $W/restart-api.sh
bash $W/worker.sh | head -3
