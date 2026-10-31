#!/usr/bin/env bash
# One measurement window per call. run.sh wraps each call in heavy-run.sh so no other heavy test runs concurrently.
#   measure.sh drain                      wait until the worker backlog is drained (<= 5 ROWS written by the runtime role in a 60 s window;
#                                         idle claim CTEs (WITH ... UPDATE ... RETURNING) run constantly but write 0 rows)
#   measure.sh idle <label> <seconds>     idle window: pg_stat_statements delta, cgroup CPU, docker stats, Redis
#   measure.sh storage-boot               worker (re)start with the S3 trace on: the boot-time storage reconcile
#   measure.sh storage-cli                worker paused; `storage:reconcile` CLI (report-only) with the S3 trace on
#   measure.sh worker-up <name> [K=V ...] (re)create the worker with base.env + K=V (Phase A configurations)
#   measure.sh boot-probe cold|restart <s> worker startup/recovery: time to ready/healthy, S3 + SQL in the first <s> seconds
#   measure.sh replicas <s> [K=V ...]     two workers booting concurrently: reconciles and S3 calls per replica, SQL
# Env: COST_TAG, OUT (results directory).
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
load_secrets
require_tag
OUT="${OUT:?OUT not set}"; assert_outside_main "the results directory (OUT)" "$OUT"; mkdir -p "$OUT"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTAINERS="costaudit-pg costaudit-worker costaudit-api costaudit-redis costaudit-minio"

cpu_snapshot() { for c in $CONTAINERS ${EXTRA_CONTAINERS:-}; do echo "$c $(cg_cpu_usec "$c" 2>/dev/null || echo 0)"; done; }

# make_worker_env: lib/worker-env.sh
. "$COST_DIR/lib/worker-env.sh"
# worker_up <name> [KEY=VALUE ...]: (re)creates costaudit-worker with that configuration (compose recreates it only if the
# configuration differs from the running container).
# If the worker does not stay up (e.g. a launcher refuses the configuration), <out>/worker-env/<name>.REFUSED records the
# last log lines (URLs redacted) and run.sh skips that configuration's window.
worker_up() {
  local name="$1" st
  make_worker_env "$@"
  rm -f "$OUT/worker-env/$name.REFUSED"
  COST_NO_PROVISIONER_URL="$WNOURL" COST_WORKER_ENV_FILE="$(hostpath "$WENV")" COST_REALTIME_ENABLED="$WRT" COST_PUSH_ENABLED="$WPU" "$HERE/stack.sh" worker
  sleep 5
  st="$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' costaudit-worker 2>/dev/null || echo missing)"
  { echo "containerEnvKeys=$(worker_env_facts costaudit-worker)"; echo "containerState=$st"; } >> "$OUT/worker-env/$name.config"
  echo "$(date -u +%FT%TZ) worker configuration '$name' (REALTIME_ENABLED=$WRT PUSH_ENABLED=$WPU, provisioner URL $([ "$WNOURL" = 1 ] && echo absent || echo present), env file: $(tr '\n' ' ' < "$WENV")) -> $st; container env keys: $(worker_env_facts costaudit-worker)" >> "$OUT/worker-configs.log"
  case "$st" in
    running*) ;;
    *)
      { echo "worker configuration '$name' did not stay up: $st"; docker logs --tail 20 costaudit-worker 2>&1 | sed -E 's#(postgres(ql)?|redis)://[^ ]+#<url>#g'; } > "$OUT/worker-env/$name.REFUSED"
      log "worker configuration '$name' did not stay up ($st); see worker-env/$name.REFUSED" ;;
  esac
}

# Read-only Redis view of BullMQ repeat/job-scheduler state (interval mode should have none; a duplicate would show here).
redis_sched_keys() {
  local k
  echo "dbsize $(redis_cli DBSIZE | tr -d '\r')"
  redis_cli --scan --pattern '*repeat*' | tr -d '\r' | sort | while IFS= read -r k; do
    [ -n "$k" ] || continue
    case "$(redis_cli TYPE "$k" | tr -d '\r')" in
      zset) echo "$k zset $(redis_cli ZCARD "$k" | tr -d '\r')" ;;
      hash) echo "$k hash $(redis_cli HLEN "$k" | tr -d '\r')" ;;
      *) echo "$k other" ;;
    esac
  done
}
# Health of one worker container: the image's own health command (worker-bundle-health.cjs: fresh heartbeats of BOTH
# children), run with docker exec, and Docker's own HEALTHCHECK status.
worker_probe_ok() { docker exec "$1" node /opt/crewflow-bundle/worker-bundle-health.cjs >/dev/null 2>&1; }
docker_health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo missing; }
# Logs since an instant, timestamped, URLs redacted (the worker never prints credentials; this is belt and braces).
worker_logs() { docker logs -t --since "$2" "$1" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g; s#(postgres(ql)?|redis)://[^ ]+#<url>#g'; }
worker_procs() { docker exec "$1" sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < $p/cmdline 2>/dev/null | cut -c1-120); [ -n "$c" ] && echo "${p#/proc/} $(awk "/^Uid/{print \$2}" $p/status) $c"; done' 2>/dev/null || true; }
pgss_dump() { # dir
  q "copy (select userid::regrole::text as role, toplevel, calls, total_exec_time, rows, shared_blks_hit, shared_blks_read, query from pg_stat_statements where dbid=(select oid from pg_database where datname='rab') order by calls desc) to stdout with csv header" > "$1/pgss-raw.csv"
  q "select userid::regrole, calls, round(total_exec_time::numeric,1), rows, toplevel, left(regexp_replace(query,'\s+',' ','g'),220) from pg_stat_statements where dbid=(select oid from pg_database where datname='rab') order by calls desc" > "$1/pgss.txt"
}
# Polls the given containers until Docker reports each healthy, or the deadline; records ms since $T0 (ns) at which the
# image's health command (docker exec, every ~2 s) first passed and at which Docker's own HEALTHCHECK (30 s interval:
# coarse) first reported healthy. Then sleeps until the deadline, so every window has the same length.
poll_health_until() { # results-dir deadline-epoch-s containers...
  local R="$1" dl="$2" c now all; shift 2
  declare -A ph=() dh=()
  while [ "$(date +%s)" -lt "$dl" ]; do
    for c in "$@"; do
      if [ -z "${ph[$c]:-}" ] && worker_probe_ok "$c"; then ph[$c]=$(( ($(date +%s%N) - T0) / 1000000 )); fi
      if [ -z "${dh[$c]:-}" ] && [ "$(docker_health "$c")" = healthy ]; then dh[$c]=$(( ($(date +%s%N) - T0) / 1000000 )); fi
    done
    all=1; for c in "$@"; do [ -n "${dh[$c]:-}" ] || all=0; done
    [ "$all" = 0 ] || break
    sleep 2
  done
  for c in "$@"; do echo "$c probeHealthyMs=${ph[$c]:-none} dockerHealthyMs=${dh[$c]:-none}"; done > "$R/health.txt"
  now=$(date +%s); [ "$now" -ge "$dl" ] || sleep $((dl - now))
}

case "${1:?usage}" in
  drain)
    : > "$OUT/drain-${2:-last}.log"
    for i in $(seq 1 30); do
      q "select pg_stat_statements_reset()" >/dev/null
      sleep 60
      w=$(q "select coalesce(sum(rows),0) from pg_stat_statements where userid='crewflow_app'::regrole and (query ilike 'insert%' or query ilike 'update%' or query ilike 'delete%' or query ilike 'with%insert%' or query ilike 'with%update%')")
      t=$(q "select coalesce(sum(calls),0) from pg_stat_statements where userid in ('crewflow_app'::regrole,'crewflow'::regrole)")
      echo "$(date -u +%H:%M:%SZ) window=$i rowsWritten=$w topLevelStatements=$t" | tee -a "$OUT/drain-${2:-last}.log" >&2
      if [ "$w" -le 5 ]; then drained=1; break; fi
    done
    [ "${drained:-0}" = 1 ] || echo "$(date -u +%H:%M:%SZ) NOT DRAINED after 30 windows (continuing; see this log)" | tee -a "$OUT/drain-${2:-last}.log" >&2
    ;;
  idle)
    L="${2:?label}"; D="${3:?seconds}"; R="$OUT/idle-$L"; mkdir -p "$R"
    # COST_IDLE_S3_TRACE=1 (run.sh --idle-s3-trace): every S3 call during the window is traced too (storage-idle-<L>.json).
    [ "${COST_IDLE_S3_TRACE:-0}" != 1 ] || "$HERE/storage-trace.sh" start "idle-$L"
    docker inspect -f '{{.Name}} {{range .Config.Env}}{{if or (eq (index (split . "=") 0) "REALTIME_ENABLED") (eq (index (split . "=") 0) "PUSH_ENABLED")}}{{.}} {{end}}{{end}}' costaudit-api costaudit-worker > "$R/flags.txt" 2>/dev/null || true
    q "select pg_stat_statements_reset()" >/dev/null
    cpu_snapshot > "$R/cpu-start.txt"; redis_cli INFO stats > "$R/redis-stats-start.txt"; date +%s > "$R/t-start"
    END=$(( $(date +%s) + D )); : > "$R/dstats.txt"; : > "$R/redis-ops.txt"; : > "$R/dstats-host.txt"
    while [ "$(date +%s)" -lt "$END" ]; do
      docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' $CONTAINERS | sed "s/^/$(date +%s),/" >> "$R/dstats.txt"
      # Host contention (read-only): the dev stack and other agents' containers keep running during the window.
      others="$(docker ps --format '{{.Names}}' | grep -vE '^(costaudit-|crewflow-cost-)' || true)"
      # shellcheck disable=SC2086
      [ -z "$others" ] || { docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' $others 2>/dev/null | sed "s/^/$(date +%s),/" >> "$R/dstats-host.txt" || true; }
      redis_cli INFO stats | grep instantaneous_ops_per_sec | tr -d '\r' | sed "s/^/$(date +%s),/" >> "$R/redis-ops.txt"
      sleep 15
    done
    date +%s > "$R/t-end"; cpu_snapshot > "$R/cpu-end.txt"
    redis_cli INFO stats > "$R/redis-stats-end.txt"; redis_cli INFO memory > "$R/redis-mem.txt"; redis_cli DBSIZE > "$R/redis-dbsize.txt"
    # Raw pg_stat_statements dump (full text, every role) + the compact views the analyser reads.
    q "copy (select userid::regrole::text as role, toplevel, calls, total_exec_time, rows, shared_blks_hit, shared_blks_read, query from pg_stat_statements where dbid=(select oid from pg_database where datname='rab') order by calls desc) to stdout with csv header" > "$R/pgss-raw.csv"
    q "select userid::regrole, calls, round(total_exec_time::numeric,1), rows, toplevel, left(regexp_replace(query,'\s+',' ','g'),220) from pg_stat_statements where dbid=(select oid from pg_database where datname='rab') order by calls desc" > "$R/pgss.txt"
    q "select usename, state, count(*) from pg_stat_activity where datname='rab' group by 1,2" > "$R/pg-activity.txt"
    docker exec costaudit-worker sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < $p/cmdline 2>/dev/null | cut -c1-90); r=$(awk "/VmRSS/{print \$2}" $p/status 2>/dev/null); [ -n "$r" ] && echo "${p#/proc/} $c RSS_kB=$r"; done' > "$R/worker-procs.txt" 2>/dev/null || true
    for c in $CONTAINERS; do echo "$c $(docker exec "$c" cat /sys/fs/cgroup/memory.current 2>/dev/null) $(docker exec "$c" cat /sys/fs/cgroup/memory.stat 2>/dev/null | awk '/^anon /{print "anon="$2}')"; done > "$R/cgroup-mem.txt"
    docker exec costaudit-pg cat /proc/meminfo | grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' > "$R/vm-meminfo.txt" || true
    if [ "${COST_IDLE_S3_TRACE:-0}" = 1 ]; then "$HERE/storage-trace.sh" stop "idle-$L"; node_env "$COST_DIR/lib/storage-ops.js" "idle-$L" > /dev/null; fi
    node_env "$COST_DIR/lib/analyze-idle.js" "$L" > /dev/null
    log "idle window $L done (${D}s)"
    ;;
  storage-boot)
    "$HERE/storage-trace.sh" start boot
    since="$(date -u +%FT%TZ)"
    hdocker_try rm -f costaudit-worker
    "$HERE/stack.sh" worker
    # Waits for the boot-time reconcile to finish, at most COST_STORAGE_BOOT_MAX_S (default 300 s; it took ~28 s at 4,320
    # stored_file rows). A build without a boot-time reconcile (Phase A) is observed for the full maximum instead.
    dl=$(( $(date +%s) + ${COST_STORAGE_BOOT_MAX_S:-300} ))
    while [ "$(date +%s)" -lt "$dl" ]; do docker logs --since "$since" costaudit-worker 2>&1 | grep -q "storage cleanup: checked=" && break; sleep 2; done
    docker logs --since "$since" costaudit-worker 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o "storage cleanup: checked=[^ ]* integrityProblems=[^ ]* orphans=[^ ]* actions=[0-9]*" | tail -1 > "$OUT/storage-boot.worker-line.txt" || true
    "$HERE/storage-trace.sh" stop boot
    node_env "$COST_DIR/lib/storage-ops.js" boot
    ;;
  flags-up)
    # flags-up on|off: REALTIME_ENABLED and PUSH_ENABLED both true (on) or both false (off = base) on the API AND the worker;
    # recreates both (the API first, waits for its health). Records the flags each container actually has.
    case "${2:?on|off}" in
      on) fname=flags-on; set -- REALTIME_ENABLED=true PUSH_ENABLED=true ;;
      off) fname=base; set -- ;;
      *) die "flags-up on|off" ;;
    esac
    make_worker_env "$fname" "$@"
    COST_REALTIME_ENABLED="$WRT" COST_PUSH_ENABLED="$WPU" "$HERE/stack.sh" api
    worker_up "$fname" "$@"
    echo "$(date -u +%FT%TZ) flags-up $fname: $(docker inspect -f '{{.Name}} {{range .Config.Env}}{{if or (eq (index (split . "=") 0) "REALTIME_ENABLED") (eq (index (split . "=") 0) "PUSH_ENABLED")}}{{.}} {{end}}{{end}}' costaudit-api costaudit-worker | tr '\n' ';')" >> "$OUT/worker-configs.log"
    ;;
  worker-up)
    # worker-up <name> [KEY=VALUE ...]   (re)create costaudit-worker with base.env + these assignments (see make_worker_env)
    shift; worker_up "$@"
    ;;
  boot-probe)
    # boot-probe cold|restart <seconds>: startup and recovery of ONE worker (base configuration), with the S3 trace on and
    # pg_stat_statements reset at the start. cold = remove the container and create a fresh one; restart = graceful
    # `docker stop` (SIGTERM, compose stop_grace_period 55 s) + `docker start` of the same container. Records the stop
    # duration, time to the "rab-worker ready" line, to the first passing image health command and to Docker's own
    # HEALTHCHECK healthy; S3 calls and SQL (by role / query) during the first <seconds>; storage reconciles; the worker's
    # processes; BullMQ repeat/scheduler keys in Redis before and after.
    L="${2:?cold|restart}"; N="${3:?seconds}"; R="$OUT/boot-$L"; rm -rf "$R"; mkdir -p "$R"
    case "$L" in cold | restart) ;; *) die "boot-probe: cold|restart" ;; esac
    make_worker_env base
    redis_sched_keys > "$R/redis-sched-before.txt"
    worker_procs costaudit-worker > "$R/procs-before.txt"
    "$HERE/storage-trace.sh" start "boot-$L"
    q "select pg_stat_statements_reset()" >/dev/null
    since="$(date -u +%FT%TZ)"; sleep 1
    T0=$(date +%s%N); stopMs=none
    if [ "$L" = cold ]; then
      hdocker_try rm -f costaudit-worker
      wdc up -d worker >/dev/null 2>&1 || die "boot-probe: could not create the worker"
    else
      hdocker stop costaudit-worker
      stopMs=$(( ($(date +%s%N) - T0) / 1000000 ))
      worker_logs costaudit-worker "$since" > "$R/worker-shutdown.log"
      hdocker start costaudit-worker
    fi
    startedAt="$(docker inspect -f '{{.State.StartedAt}}' costaudit-worker)"
    cpu_snapshot > "$R/cpu-start.txt"
    poll_health_until "$R" $(( T0 / 1000000000 + N )) costaudit-worker
    cpu_snapshot > "$R/cpu-end.txt"
    "$HERE/storage-trace.sh" stop "boot-$L"
    pgss_dump "$R"
    worker_logs costaudit-worker "$since" > "$R/worker.log"
    worker_procs costaudit-worker > "$R/procs.txt"
    redis_sched_keys > "$R/redis-sched-after.txt"
    docker inspect -f '{{json .State.Health}}' costaudit-worker > "$R/docker-health.json" 2>/dev/null || true
    { echo "t0Ns=$T0"; echo "windowS=$N"; echo "stopMs=$stopMs"; echo "startedAt=$startedAt"; echo "since=$since"; echo "restartCount=$(docker inspect -f '{{.RestartCount}}' costaudit-worker)"; } > "$R/times.env"
    node_env "$COST_DIR/lib/storage-ops.js" "boot-$L" > /dev/null
    node_env "$COST_DIR/lib/analyze-boot.js" "boot-$L" costaudit-worker >&2
    ;;
  replicas)
    # replicas <seconds> [KEY=VALUE ...]: a fresh costaudit-worker AND a second replica costaudit-worker2 (same image and
    # configuration: base.env + the assignments) started concurrently, S3 trace on, pg_stat_statements reset. After
    # <seconds>: storage reconciles per replica (log lines), S3 calls per replica (trace, by client container), SQL by
    # role/query, health timings. Then worker2 is removed and costaudit-worker is put back on the base configuration.
    N="${2:?seconds}"; shift 2; R="$OUT/replicas"; rm -rf "$R"; mkdir -p "$R"
    make_worker_env replicas "$@"
    redis_sched_keys > "$R/redis-sched-before.txt"
    "$HERE/storage-trace.sh" start replicas
    q "select pg_stat_statements_reset()" >/dev/null
    since="$(date -u +%FT%TZ)"; sleep 1
    T0=$(date +%s%N)
    hdocker_try rm -f costaudit-worker costaudit-worker2
    wdc --profile replica up -d worker worker2 >/dev/null 2>&1 || die "replicas: could not create the two workers"
    EXTRA_CONTAINERS=costaudit-worker2 cpu_snapshot > "$R/cpu-start.txt"
    poll_health_until "$R" $(( T0 / 1000000000 + N )) costaudit-worker costaudit-worker2
    EXTRA_CONTAINERS=costaudit-worker2 cpu_snapshot > "$R/cpu-end.txt"
    "$HERE/storage-trace.sh" stop replicas
    pgss_dump "$R"
    for c in costaudit-worker costaudit-worker2; do worker_logs "$c" "$since" > "$R/$c.log"; worker_procs "$c" > "$R/$c.procs.txt"; done
    redis_sched_keys > "$R/redis-sched-after.txt"
    { echo "t0Ns=$T0"; echo "windowS=$N"; echo "since=$since"; } > "$R/times.env"
    node_env "$COST_DIR/lib/storage-ops.js" replicas > /dev/null
    node_env "$COST_DIR/lib/analyze-boot.js" replicas costaudit-worker costaudit-worker2 >&2
    hdocker stop costaudit-worker2
    hdocker rm costaudit-worker2
    worker_up base
    ;;
  storage-cli)
    hdocker pause costaudit-worker
    trap 'hdocker_try unpause costaudit-worker' EXIT
    "$HERE/storage-trace.sh" start cli
    t0=$(date +%s%N)
    dc --profile ops run --rm -T tool node packages/rab-server/dist/command/main.js storage:reconcile > "$OUT/storage-cli.report.txt" 2>&1 || log "storage:reconcile exited non-zero (see storage-cli.report.txt)"
    t1=$(date +%s%N)
    "$HERE/storage-trace.sh" stop cli
    echo "$(( (t1 - t0) / 1000000 ))" > "$OUT/storage-cli.wall-ms"
    node_env "$COST_DIR/lib/storage-ops.js" cli
    ;;
  endpoints)
    node_env "$COST_DIR/lib/endpoints.js" "${2:-baseline}" | tee "$OUT/endpoints-${2:-baseline}.log" >&2
    ;;
  load)
    : "${COST_LOADGEN_IMAGE:?COST_LOADGEN_IMAGE not set}"
    COST_LOADGEN_IMAGE="$COST_LOADGEN_IMAGE" node_env "$COST_DIR/lib/loadtest.js" "${2:-baseline}" | tee "$OUT/load-${2:-baseline}.log" >&2
    ;;
  pdf)
    # Real renderer, --cpus=1 like the worker; uid 1000 = the jobs child's identity; script on stdin (no bind mount).
    hdocker_try rm -f costaudit-pdfbench
    docker run -i --rm --name costaudit-pdfbench --label "$COST_HARNESS_LABEL=true" --network none --cpus=1 --memory=1g --user 1000:1000 -e "N=${PDF_N:-10}" \
      --entrypoint node "crewflow-cost/worker:$COST_TAG" - < "$COST_DIR/lib/pdf-bench.js" > "$OUT/pdfbench.log" 2>&1 || die "pdf bench failed (see $OUT/pdfbench.log)"
    grep '^RESULT ' "$OUT/pdfbench.log" | sed 's/^RESULT //' > "$OUT/pdfbench.json"
    log "pdf bench: $(node -e "const j=require('$(hostpath "$OUT")/pdfbench.json');console.log(Object.entries(j.docs).map(([k,v])=>k+' '+v.summary.cpuSecondsMedian+' CPU-s').join(', '))")"
    ;;
  emails)
    N="${EMAIL_N:-200}" node_env "$COST_DIR/lib/emails-bullmq.js" | tee "$OUT/emails-bullmq.log" >&2
    ;;
  shift-cycle)
    "$HERE/storage-trace.sh" start shiftcycle
    node_env "$COST_DIR/lib/shift-cycle.js" prepare "${2:-20}" >&2
    node_env "$COST_DIR/lib/shift-cycle.js" collect >&2
    "$HERE/storage-trace.sh" stop shiftcycle
    node_env "$COST_DIR/lib/storage-ops.js" shiftcycle >&2
    ;;
  *) die "unknown measurement $1" ;;
esac
