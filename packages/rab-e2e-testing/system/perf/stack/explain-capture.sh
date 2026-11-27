#!/usr/bin/env bash
# EXPLAIN (ANALYZE, BUFFERS) evidence for the slowest statements: auto_explain on the disposable cluster for one short,
# UNMEASURED capture run at low load (so the plans show each statement's own cost, not queueing), logged by the logging
# collector to files under the cluster's data directory. Every setting is reset afterwards.
#   bash explain-capture.sh [label=explain] [min duration ms=100] [phases=capture:240:0.3]
set -uo pipefail
W=/data/crewtest-lanef
P=$W/psql.sh
L="${1:-explain}"
R=$W/results/$L
mkdir -p "$R"
for f in api worker; do [ -f $W/$f.pid ] && kill "$(cat $W/$f.pid)" 2> /dev/null; done
sleep 3
# auto_explain's parameters exist only once the module is loaded in the session that sets them. session_preload_libraries, not
# shared_preload_libraries: the container's command line pins the latter (pg_stat_statements), and a command-line -c wins.
bash $P -q -c "LOAD 'auto_explain'" \
  -c "ALTER SYSTEM SET session_preload_libraries = 'auto_explain'" -c "ALTER SYSTEM SET logging_collector = on" \
  -c "ALTER SYSTEM SET log_directory = 'lanef-log'" -c "ALTER SYSTEM SET auto_explain.log_min_duration = '${2:-100}ms'" \
  -c "ALTER SYSTEM SET auto_explain.log_analyze = on" -c "ALTER SYSTEM SET auto_explain.log_buffers = on"
# The old log directory goes BEFORE the restart: the collector would keep writing to a deleted file.
sudo rm -rf $W/pgdata/lanef-log
docker restart crewtest-lanef-pg > /dev/null
for _ in $(seq 1 60); do docker exec crewtest-lanef-pg pg_isready -h 127.0.0.1 > /dev/null 2>&1 && break; sleep 1; done
bash $W/run-load.sh "$L-run" "${3:-capture:240:0.3}" > "$R/run.out" 2>&1
for f in api worker; do [ -f $W/$f.pid ] && kill "$(cat $W/$f.pid)" 2> /dev/null; done
sleep 3
sudo sh -c "cat $W/pgdata/lanef-log/*.log" > "$R/auto-explain.log"
bash $P -q -c "LOAD 'auto_explain'" -c "ALTER SYSTEM RESET logging_collector" -c "ALTER SYSTEM RESET log_directory" \
  -c "ALTER SYSTEM RESET auto_explain.log_min_duration" -c "ALTER SYSTEM RESET auto_explain.log_analyze" -c "ALTER SYSTEM RESET auto_explain.log_buffers" \
  -c "ALTER SYSTEM RESET session_preload_libraries"
docker restart crewtest-lanef-pg > /dev/null
for _ in $(seq 1 60); do docker exec crewtest-lanef-pg pg_isready -h 127.0.0.1 > /dev/null 2>&1 && break; sleep 1; done
sudo rm -rf $W/pgdata/lanef-log
echo "plans captured: $(grep -c 'duration: .* ms  plan:' "$R/auto-explain.log")"
