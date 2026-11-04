#!/usr/bin/env bash
# D-Q6 benchmark driver: the Worker dispatch architectures on one host, at one organisation level, idle and loaded.
# Extends the Phase D after-measurement drivers (d-levels.sh / d-modes.sh, #24 A/B) and reuses this harness's guarded
# helpers only (dc, hdocker, q, measure.sh). Disposable crewflow-cost stack only; it never touches another container,
# database or Redis. Build the stack first and keep it:
#   COST_HEAVY_LABEL=dq6 bash scripts/run.sh --commit <sha> --only build,stack --keep --out <OUT>
#
#   OUT=<dir> COST_TAG=<tag> bash scripts/dq6-bench.sh setup [orgs]         seed orgs 1..N (default 200) + history, bench devices
#   OUT=<dir> COST_TAG=<tag> bash scripts/dq6-bench.sh arm <arm> <rep>      one arm, one repetition (wrap it in heavy-run.sh)
#   OUT=<dir> COST_TAG=<tag> bash scripts/dq6-bench.sh abab "<arms>" <reps> each repetition of every arm in turn, each one
#                                                                           in its own heavy-run.sh window
#   OUT=<dir> bash scripts/dq6-bench.sh report                              results tables (lib/dq6-report.js)
#
# Arms (Worker as crewflow_app for per_scope, as crewflow_worker for global; dispatch mode poll, the production default):
#   per_scope          WORKER_CLAIM_MODE=per_scope                         (the production default; D0-comparable)
#   global             WORKER_CLAIM_MODE=global                            (Phase D)
#   global_combined    global + WORKER_SHIFT_SCAN_MODE=combined            (D-Q4a; refused unless the image knows the key)
#   per_scope_combined per_scope + WORKER_SHIFT_SCAN_MODE=combined         (D-Q4a measured on its own against per_scope)
#
# One repetition of an arm (labels <arm>-r<rep>-*):
#   idle-off   realtime + push OFF (production default), drained, DQ6_IDLE_S idle window          (measure.sh idle)
#   idle-on    realtime + push ON, drained, idle window                                           (measure.sh idle)
#   loaded     realtime + push ON; DQ6_RATE notifications/s (each = notification + realtime + push + email rows) round-robin
#              over every organisation for DQ6_IDLE_S + 30 s; the resource window is the middle DQ6_IDLE_S
#              (measure.sh idle, generator transactions subtracted); latency/depth/duplicates/fairness (lib/dq6-load.js)
#   burst      DQ6_BURST notifications inserted at once (500 per transaction): drain time, rows/s, per-org completion
#   rworker    DQ6_REC_RATE/s for 60 s, graceful Worker stop, 30 s down, start, 60 s more: recovery timings
#   rredis     the same with Redis stopped (no persistence: Redis comes back EMPTY, i.e. a Redis data loss)
# Delayed triggers (D-Q4b) are OFF in every arm (the key is never set); they are not part of this measurement.
#
# Clock budget: the seed's logical clock leaves no shift inside the Worker's 180-minute roster window for ~5 h after
# seeding (DQ6_SEED_NOW). `arm` refuses to measure once a published shift starts within 3 h 15 min, so a late run cannot
# silently include roster PDF renders; re-seed a fresh stack instead.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${OUT:?OUT (results directory) not set}"; export OUT
assert_outside_main "the results directory (OUT)" "$OUT"
mkdir -p "$OUT"
cmd="${1:?usage: dq6-bench.sh setup|arm|abab|report ...}"; shift
if [ "$cmd" = report ]; then node_env "$COST_DIR/lib/dq6-report.js"; exit 0; fi
load_secrets
require_tag
M="$HERE/measure.sh"
HEAVY="${COST_HEAVY_RUN:-/c/rab-ai-wt/setup/heavy-run.sh}"
HLABEL="${COST_HEAVY_LABEL:-dq6}"
IDLE_S="${DQ6_IDLE_S:-300}"
RATE="${DQ6_RATE:-10}"
BURST="${DQ6_BURST:-2000}"
REC_RATE="${DQ6_REC_RATE:-5}"
LOAD="$COST_DIR/lib/dq6-load.js"
export COST_WORKER_ENV_FILE; COST_WORKER_ENV_FILE="$(hostpath "$OUT/worker-env/base.env")"
mkdir -p "$OUT/worker-env"; [ -f "$OUT/worker-env/base.env" ] || : > "$OUT/worker-env/base.env"
cd "$REPO"

stamp() { echo "$(date -u +%FT%TZ) $*" | tee -a "$OUT/dq6-run.log" >&2; }

host_snapshot() { # label: the non-harness containers' CPU (host contention), read-only
  local others
  others="$(docker ps --format '{{.Names}}' | grep -vE '^(costaudit-|crewflow-cost-)' || true)"
  # shellcheck disable=SC2086
  { echo "# $(date -u +%FT%TZ) $1"; [ -z "$others" ] || docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' $others 2>/dev/null; } >> "$OUT/host-contention.txt" || true
}

record_mode() { # what the containers actually run with (env keys from docker inspect, login roles from pg_stat_activity)
  local L="$1"
  { echo "label=$L"
    docker inspect -f '{{.Name}} {{range .Config.Env}}{{if or (eq (index (split . "=") 0) "WORKER_CLAIM_MODE") (eq (index (split . "=") 0) "WORKER_DISPATCH_MODE") (eq (index (split . "=") 0) "WORKER_SHIFT_SCAN_MODE") (eq (index (split . "=") 0) "WORKER_TIMER_TRIGGERS") (eq (index (split . "=") 0) "REALTIME_ENABLED") (eq (index (split . "=") 0) "PUSH_ENABLED")}}{{.}} {{end}}{{end}}' costaudit-api costaudit-worker
    q "select usename, application_name, count(*) from pg_stat_activity where datname='rab' group by 1,2 order by 1,2"
  } > "$OUT/mode-$L.txt" 2>&1 || true
}

image_knows_combined() { # D-Q4a present in this image? (grep the built Worker for the flag name)
  docker run --rm --label "$COST_HARNESS_LABEL=true" --network none --entrypoint sh "crewflow-cost/worker:$COST_TAG" \
    -c 'grep -rlq WORKER_SHIFT_SCAN_MODE /app/packages/rab-worker/dist /app/packages/rab-server/dist 2>/dev/null' 2>/dev/null
}

set_arm() {
  unset COST_WORKER_CLAIM_MODE COST_WORKER_DISPATCH_MODE COST_WORKER_DB_USER COST_WORKER_DB_PW
  : > "$OUT/worker-env/base.env"
  case "$1" in
    per_scope | per_scope_combined) ;;
    global | global_combined)
      export COST_WORKER_CLAIM_MODE=global COST_WORKER_DB_USER=crewflow_worker COST_WORKER_DB_PW="$CREWFLOW_WORKER_PW" ;;
    *) die "unknown arm '$1' (per_scope | global | per_scope_combined | global_combined)" ;;
  esac
  case "$1" in
    *_combined)
      image_knows_combined || die "arm $1: crewflow-cost/worker:$COST_TAG has no WORKER_SHIFT_SCAN_MODE (D-Q4a not in this build)"
      echo "WORKER_SHIFT_SCAN_MODE=combined" > "$OUT/worker-env/base.env" ;;
  esac
}

clock_guard() {
  local n
  n="$(q "select count(*) from core.shift where status not in ('cancelled','completed','draft') and starts_at > now() and starts_at <= now() + interval '3 hours 15 minutes'")"
  [ "$n" = 0 ] || die "clock budget exhausted: $n published shift(s) start within 3 h 15 min (roster PDF renders would enter the window). Re-seed a fresh stack."
  n="$(q "select count(*) from core.shift where status not in ('cancelled','completed','draft') and starts_at <= now() and ends_at > now()")"
  [ "$n" = 0 ] || die "clock: $n shift(s) in progress; the seed clock is off"
}

ensure_flags() { # on|off: recreate API + Worker with that configuration (no-op recreation is cheap) and record it
  bash "$M" flags-up "$1"
  [ "$(docker inspect -f '{{.State.Status}}' costaudit-worker 2>/dev/null)" = running ] || die "costaudit-worker is not running after flags-up $1"
}

idle_window() { # label
  stamp "drain before $1"; bash "$M" drain "$1"
  host_snapshot "$1 start"; bash "$M" idle "$1" "$IDLE_S"; host_snapshot "$1 end"
}

do_setup() {
  local N="${1:-200}" now="${DQ6_SEED_NOW:-2026-10-27T22:05:00Z}" ok=0 i
  stamp "setup: seed orgs 1-$N (COST_SEED_NOW=$now), Worker stopped during seed and history backfill"
  hdocker stop costaudit-worker
  dc --profile ops run --rm -T -e ORG_FROM=1 -e ORG_TO="$N" -e COST_SEED_NOW="$now" tool node /cost/seed/seed.js > "$OUT/seed-1-$N.log" 2>&1 || die "seed failed (seed-1-$N.log)"
  head -1 "$OUT/seed-1-$N.log" >&2 || true
  for i in 1 2 3; do
    if dc --profile ops run --rm -T tool node /cost/seed/backfill-reports.js > "$OUT/backfill-1-$N-try$i.log" 2>&1; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || die "history backfill failed after 3 tries"
  # The day's LAST shifts end just before the logical "now"; their post-shift stamps would otherwise fall due one and two
  # hours into the run and land inside one arm's window. Mark them processed now, like the backfill does for older history.
  q "update core.attendance set post_shift_completed_at = coalesce(post_shift_completed_at, clock_out_at + interval '1 hour'),
       post_shift_expired_at = coalesce(post_shift_expired_at, clock_out_at + interval '2 hours'), updated_at = now()
     where clock_out_at is not null and (post_shift_completed_at is null or post_shift_expired_at is null)" > "$OUT/setup-history-stamps.txt"
  echo "$(q "select count(*) from core.organisation") orgs, $(q "select count(*) from core.manager_workspace") workspaces, db $(q "select pg_size_pretty(pg_database_size('rab'))")" > "$OUT/scale.txt"
  stamp "scale: $(cat "$OUT/scale.txt")"
  q "select relname||'|'||n_live_tup from pg_stat_user_tables where schemaname='core' and n_live_tup>0 order by n_live_tup desc" > "$OUT/rowcounts-after-seed.txt"
  set_arm per_scope
  ensure_flags off
  node_env "$LOAD" devices | tee -a "$OUT/dq6-run.log" >&2
  stamp "setup: drain after seed"; bash "$M" drain setup
  clock_guard
  stamp "setup done"
}

do_arm() {
  local arm="$1" rep="$2" L
  L="$arm-r$rep"
  clock_guard
  set_arm "$arm"
  stamp "arm $L: start (rate ${RATE}/s, burst $BURST, idle ${IDLE_S}s)"
  ensure_flags off; record_mode "$L-idle-off"
  idle_window "$L-idle-off"
  ensure_flags on; record_mode "$L-idle-on"
  idle_window "$L-idle-on"
  # loaded: generator runs IDLE_S + 30 s; the resource window is its middle IDLE_S seconds
  stamp "arm $L: loaded"
  host_snapshot "$L-loaded start"
  node_env "$LOAD" steady "$L-loaded" --seconds $((IDLE_S + 30)) --rate "$RATE" > "$OUT/dq6-$L-loaded.log" 2>&1 &
  local gen=$!
  sleep 15
  bash "$M" idle "$L-loaded" "$IDLE_S"
  wait "$gen" || stamp "arm $L: loaded generator FAILED (dq6-$L-loaded.log)"
  host_snapshot "$L-loaded end"
  stamp "arm $L: loaded $(tail -1 "$OUT/dq6-$L-loaded.log" | cut -c1-300)"
  stamp "arm $L: burst"; bash "$M" drain "$L-burst"
  host_snapshot "$L-burst start"
  node_env "$LOAD" burst "$L-burst" --notifications "$BURST" > "$OUT/dq6-$L-burst.log" 2>&1 || stamp "arm $L: burst FAILED"
  host_snapshot "$L-burst end"
  stamp "arm $L: burst $(tail -1 "$OUT/dq6-$L-burst.log" | cut -c1-300)"
  stamp "arm $L: Worker restart"
  host_snapshot "$L-rworker start"
  node_env "$LOAD" recovery "$L-rworker" worker --rate "$REC_RATE" > "$OUT/dq6-$L-rworker.log" 2>&1 || stamp "arm $L: rworker FAILED"
  stamp "arm $L: rworker $(tail -1 "$OUT/dq6-$L-rworker.log" | cut -c1-400)"
  ensure_flags on; bash "$M" drain "$L-rredis"
  stamp "arm $L: Redis restart"
  host_snapshot "$L-rredis start"
  node_env "$LOAD" recovery "$L-rredis" redis --rate "$REC_RATE" > "$OUT/dq6-$L-rredis.log" 2>&1 || stamp "arm $L: rredis FAILED"
  stamp "arm $L: rredis $(tail -1 "$OUT/dq6-$L-rredis.log" | cut -c1-400)"
  # Redis lost every BullMQ key and connection; recreate the API and Worker so the next arm starts from a clean process.
  hdocker_try rm -f costaudit-worker
  ensure_flags off
  stamp "arm $L: done"
}

case "$cmd" in
  setup) do_setup "${1:-200}" ;;
  arm) do_arm "${1:?arm}" "${2:?rep}" ;;
  abab)
    arms="${1:?arms, e.g. \"per_scope global\"}"; reps="${2:-2}"
    for r in $(seq 1 "$reps"); do
      for a in $arms; do
        bash "$HEAVY" "$HLABEL" bash "$HERE/dq6-bench.sh" arm "$a" "$r" || stamp "arm $a r$r exited non-zero"
      done
    done ;;
  *) die "unknown command $cmd" ;;
esac
