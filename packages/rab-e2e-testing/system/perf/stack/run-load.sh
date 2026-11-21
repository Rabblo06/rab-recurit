#!/usr/bin/env bash
# One measured load run: fresh live batch, stack up, pg_stat_statements reset, load-mix, top statements, resource tail.
#   bash run-load.sh <label> [PERF_PHASES]
set -uo pipefail
W=/data/crewtest-lanef
LABEL="${1:?label}"; PH="${2:-warmup:120:0.5,peak:900:1,spike:180:2,recovery:120:1}"
. $W/env.sh
R=$W/results/$LABEL; mkdir -p $R
cd $W/rab
cp $W/seed-volume.mjs $W/load-mix.mjs $W/sinks.mjs packages/rab-e2e-testing/system/perf/
for f in api worker; do [ -f $W/$f.pid ] && kill "$(cat $W/$f.pid)" 2>/dev/null; done; sleep 3
echo "[$LABEL] live batch"
bash $W/seedvol.sh --batch live --staff 5000 --live-bookings 1500 --pending-offers 2000 --live-start "$(date -u -d '+8 minutes' +%FT%TZ)" --live-minutes 22 --out $R/work.json | grep -v '"step"' | tail -3
echo "[$LABEL] stack up"
bash $W/up.sh | tail -2
sleep 45
P=$W/psql.sh
bash $P -d postgres -q -c "select pg_stat_statements_reset()" >/dev/null; bash $P -q -c "select pg_stat_reset()" >/dev/null
bash $P -At -c "select now()" > $R/t-start
PW="$(sed -n "s/^export E2E_SEED_PASSWORD='\(.*\)'$/\1/p" $W/seed/live.env)"
VM="$(bash $P -At -c "select email from core.\"user\" where first_name = 'Vera' and last_name = 'Mills' limit 1")"
echo "[$LABEL] load ($PH)"
PERF_API=http://127.0.0.1:3490 PERF_ORIGIN=https://app.lanef.test PERF_PASSWORD="$PW" PERF_APP_SECRET="$LF_APP_SECRET" PERF_WORK=$R/work.json \
  PERF_VM_EMAIL="$VM" PERF_PHASES="$PH" PERF_SEARCH_TERMS="${PERF_SEARCH_TERMS:-}" PERF_PG_CONTAINER=crewtest-lanef-pg PERF_API_PID="$(cat $W/api.pid)" PERF_WORKER_PID="$(cat $W/worker.pid)" \
  taskset -c 3 node packages/rab-e2e-testing/system/perf/load-mix.mjs $R/load.json 2>&1 | tee $R/load.txt
unset PW
bash $P -At -c "select now()" > $R/t-end
# Top statements by total time and by mean (application login only), and table stats.
bash $P -d postgres -F $'\t' -At -c "select round(s.total_exec_time::numeric,1), s.calls, round(s.mean_exec_time::numeric,3), round(s.max_exec_time::numeric,1), s.rows, s.shared_blks_hit, s.shared_blks_read, s.queryid, regexp_replace(s.query, '[[:space:]]+', ' ', 'g') from pg_stat_statements s join pg_roles r on r.oid = s.userid where r.rolname <> 'lanef_admin' and s.dbid = (select oid from pg_database where datname = 'crewflow') order by s.total_exec_time desc limit 60" > $R/pgss-top-total.tsv
bash $P -d postgres -F $'\t' -At -c "select round(s.mean_exec_time::numeric,3), s.calls, round(s.total_exec_time::numeric,1), round(s.max_exec_time::numeric,1), s.queryid, regexp_replace(s.query, '[[:space:]]+', ' ', 'g') from pg_stat_statements s join pg_roles r on r.oid = s.userid where r.rolname <> 'lanef_admin' and s.dbid = (select oid from pg_database where datname = 'crewflow') and s.calls >= 5 order by s.mean_exec_time desc limit 40" > $R/pgss-top-mean.tsv
bash $P -F $'\t' -At -c "select schemaname||'.'||relname, seq_scan, seq_tup_read, idx_scan, n_live_tup from pg_stat_user_tables where seq_scan > 0 order by seq_tup_read desc limit 25" > $R/seqscans.tsv
grep -cE "ERROR|Error:" $W/logs/api.log > $R/api-error-lines.txt; sed -E 's#(postgres(ql)?|redis)://[^ "]+#<url>#g' $W/logs/api.log | grep -E "ERROR" | sort | uniq -c | sort -rn | head -20 > $R/api-errors.txt
cp $W/sinkdata/sinks-stats.json $R/ 2>/dev/null
df -h /data / | tail -2 > $R/df.txt
echo "[$LABEL] done -> $R"
