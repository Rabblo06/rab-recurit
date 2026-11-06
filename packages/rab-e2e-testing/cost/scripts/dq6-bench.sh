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
# Realistic journeys (k6, the realistic-load-test method; README "D-Q6 realistic journeys"), after `setup`:
#   OUT=<dir> COST_TAG=<tag> bash scripts/dq6-bench.sh k6prep               VM teams (k6/seed-teams.sql) + the dataset template
#   OUT=<dir> COST_TAG=<tag> bash scripts/dq6-bench.sh k6smoke              2-org functional run (consumes data: k6arm restores)
#   OUT=<dir> COST_TAG=<tag> bash scripts/dq6-bench.sh k6arm <mode> <rep>   restore the dataset, mode config, idle + k6 window
#   OUT=<dir> COST_TAG=<tag> bash scripts/dq6-bench.sh k6abab "<modes>" <reps>  every mode per repetition, NOT wrapped:
#                                                                           run the whole k6abab inside ONE heavy-run window
# Modes (per_scope claims, poll, realtime + push OFF, and main's production delivery settings in EVERY mode:
# WORKER_FAST_PUBLISH_NOTIFY=true + WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS=30 on the API and the Worker, PR #84):
#   baseline  every Phase D flag off
#   combined  + WORKER_SHIFT_SCAN_MODE=combined (D-Q4a, Worker)
#   triggers  + WORKER_TIMER_TRIGGERS=on (D-Q4b, API + Worker; WORKER_TIMER_TRIGGER_KINDS unset = all four kinds, as the
#             timer shadow run)
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
#              over every organisation for DQ6_IDLE_S + 90 s; the resource window is DQ6_IDLE_S starting 15 s in, and the
#              report accepts it only if the generator's own recorded run covers it
#              (measure.sh idle, generator transactions subtracted); latency/depth/duplicates/fairness (lib/dq6-load.js)
#   burst      DQ6_BURST notifications inserted at once (500 per transaction): drain time, rows/s, per-org completion
#   rworker    DQ6_REC_RATE/s for 60 s, graceful Worker stop, 30 s down, start, 60 s more: recovery timings
#   rredis     the same with Redis stopped (no persistence: Redis comes back EMPTY, i.e. a Redis data loss)
# Delayed triggers (D-Q4b) are OFF in every arm (the key is never set); they are not part of this measurement.
#
# Clock budget: the seed's logical clock leaves no shift inside the Worker's 180-minute roster window for ~5 h after
# seeding (DQ6_SEED_NOW). Before EVERY window and scenario (after its drain) and at the end of each arm, the guard refuses
# to go on once a published shift starts within the roster window plus DQ6_CLOCK_MARGIN_MIN (45 min: longer than the
# longest scenario, a recovery with its 900 s collection cap, about 18 min), so a late run cannot
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
  vm_snapshot "$1"
}

# Docker VM memory (4 GB, shared with the dev and parity stacks): MemAvailable, SwapFree and the cumulative swap-in/out
# page counters, read from /proc inside the disposable Postgres container (the VM's own counters, not the cgroup's).
# One line per window edge in vm-memory.txt: "<label> <start|end> t=<epoch> availMiB= swapFreeMiB= pswpin= pswpout=".
# lib/dq6-report.js excludes a window that swapped in more than DQ6_MAX_SWAPIN_MIB or whose edges fell below
# DQ6_MIN_AVAIL_MIB, and one with no record at all (fail closed: a window not shown to be unstarved is not reported).
vm_counters() {
  docker exec costaudit-pg sh -c 'awk '"'"'/^MemAvailable:/{a=int($2/1024)} /^SwapFree:/{s=int($2/1024)} END{printf "availMiB=%d swapFreeMiB=%d", a, s}'"'"' /proc/meminfo; awk '"'"'/^pswpin /{i=$2} /^pswpout /{o=$2} END{printf " pswpin=%s pswpout=%s\n", i, o}'"'"' /proc/vmstat' 2>/dev/null
}
vm_snapshot() { # "<label> <start|end>"
  local v h c r; v="$(vm_counters)" || v=""
  # Attribution only (no verdict uses it): anon pages the harness's own containers faulted back in from swap so far
  # (cgroup v2 workingset_refault_anon, cumulative per container; a recreated container restarts at 0).
  # Also per container (pg:N,worker:N,...): a container the scenario restarts (Worker, Redis) restarts its counter, and the
  # report then counts that container's end value as a lower bound instead of losing the whole window's attribution.
  local per=""
  h=0
  for c in costaudit-pg costaudit-worker costaudit-redis costaudit-api costaudit-minio; do
    r="$(docker exec "$c" sh -c 'awk "/^workingset_refault_anon /{print \$2}" /sys/fs/cgroup/memory.stat' 2>/dev/null)" || r=0
    case "$r" in '' | *[!0-9]*) r=0 ;; esac
    h=$(( h + r )); per="${per:+$per,}${c#costaudit-}:$r"
  done
  [ -n "$v" ] && echo "$1 t=$(date +%s) $v harnessRefaultPages=$h harnessRefaultByContainer=$per" >> "$OUT/vm-memory.txt" || true
}
MIN_AVAIL_MIB="${DQ6_MIN_AVAIL_MIB:-384}"
case "$MIN_AVAIL_MIB" in '' | *[!0-9]*) die "DQ6_MIN_AVAIL_MIB must be whole MiB" ;; esac
mem_guard() { # [where]: refuse to start a window on a VM already short of memory (numbers from a starved host are void)
  local v a
  v="$(vm_counters)" || die "memory guard: cannot read the VM's /proc/meminfo"
  a="$(echo "$v" | sed -n 's/.*availMiB=\([0-9]*\).*/\1/p')"
  [ -n "$a" ] || die "memory guard: no MemAvailable in '$v'"
  [ "$a" -ge "$MIN_AVAIL_MIB" ] || die "memory guard${1:+ before $1}: Docker VM MemAvailable ${a} MiB < DQ6_MIN_AVAIL_MIB=${MIN_AVAIL_MIB} ($v). Not starting a window on a starved host."
}

record_mode() { # what the containers actually run with (env keys from docker inspect, login roles from pg_stat_activity)
  local L="$1"
  { echo "label=$L"
    # WORKER_* and the two flags only (configuration, never a URL or a secret).
    for c in costaudit-api costaudit-worker; do
      echo "$c $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -E '^(WORKER_[A-Z0-9_]+|REALTIME_ENABLED|PUSH_ENABLED)=' | sort | tr '\n' ' ')"
    done
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

CLOCK_MARGIN_MIN="${DQ6_CLOCK_MARGIN_MIN:-45}"
case "$CLOCK_MARGIN_MIN" in '' | *[!0-9]*) die "DQ6_CLOCK_MARGIN_MIN must be whole minutes" ;; esac
# The margin must outlast the longest single window or scenario that follows one guard check, with today's settings:
#   idle window IDLE_S (+15 s sampling overrun); loaded: 15 s + generator (IDLE_S + LOADED_EXTRA_S) + 600 s collection cap;
#   burst: 60 s inserts + 900 s cap; recovery: 60 + 30 + 60 s + 180 s readiness cap + 900 s cap.
LOADED_EXTRA_S=90
longest_s=$(( IDLE_S + 15 ))
for s in $(( 15 + IDLE_S + LOADED_EXTRA_S + 600 )) $(( 60 + 900 )) $(( 60 + 30 + 60 + 180 + 900 )); do [ "$s" -le "$longest_s" ] || longest_s=$s; done
need_min=$(( (longest_s + 59) / 60 + 1 ))
[ "$CLOCK_MARGIN_MIN" -ge "$need_min" ] || die "DQ6_CLOCK_MARGIN_MIN=$CLOCK_MARGIN_MIN is shorter than the longest window/scenario (${longest_s} s with DQ6_IDLE_S=$IDLE_S): use at least $need_min"
clock_guard() { # [where]: before every window/scenario; the roster window is 180 min
  local n where="${1:-}"
  n="$(q "select count(*) from core.shift where status not in ('cancelled','completed','draft') and starts_at > now() and starts_at <= now() + make_interval(mins => 180 + $CLOCK_MARGIN_MIN)")"
  [ "$n" = 0 ] || die "clock budget exhausted${where:+ before $where}: $n published shift(s) start within 180 + $CLOCK_MARGIN_MIN min (roster PDF renders would enter the window). Re-seed a fresh stack."
  n="$(q "select count(*) from core.shift where status not in ('cancelled','completed','draft') and starts_at <= now() and ends_at > now()")"
  [ "$n" = 0 ] || die "clock: $n shift(s) in progress; the seed clock is off"
}

ensure_flags() { # on|off: recreate API + Worker with that configuration (no-op recreation is cheap) and record it
  bash "$M" flags-up "$1"
  [ "$(docker inspect -f '{{.State.Status}}' costaudit-worker 2>/dev/null)" = running ] || die "costaudit-worker is not running after flags-up $1"
}

idle_window() { # label
  stamp "drain before $1"; bash "$M" drain "$1"
  clock_guard "$1"; mem_guard "$1"
  host_snapshot "$1 start"; bash "$M" idle "$1" "$IDLE_S"; host_snapshot "$1 end"
}

do_setup() {
  local N="${1:-200}" now="${DQ6_SEED_NOW:-2026-10-27T22:05:00Z}" ok=0 i
  local have run
  run="$(date -u +%Y%m%dT%H%M%SZ)"
  have="$(q "select count(*) from core.organisation where slug like 'costaudit-%'")"
  hdocker stop costaudit-worker
  if [ "$have" = "$N" ] && [ -f "$OUT/seed-1-$N.log" ] && grep -q "\"org\":\"costaudit-$N\"" "$OUT/seed-1-$N.log"; then
    # Resume: a previous setup completed the seed and failed later (e.g. the history backfill). The seed is not re-run
    # (it is not idempotent); everything after it is.
    stamp "setup: seed of orgs 1-$N already complete (seed-1-$N.log); resuming at the history backfill, Worker stopped"
  elif [ "$have" = 0 ]; then
    stamp "setup: seed orgs 1-$N (COST_SEED_NOW=$now), Worker stopped during seed and history backfill"
    dc --profile ops run --rm -T -e ORG_FROM=1 -e ORG_TO="$N" -e COST_SEED_NOW="$now" tool node /cost/seed/seed.js > "$OUT/seed-1-$N.log" 2>&1 || die "seed failed (seed-1-$N.log)"
    head -1 "$OUT/seed-1-$N.log" >&2 || true
  else
    die "setup: $have costaudit organisations exist, expected 0 (fresh stack) or $N with a complete seed-1-$N.log; re-create the stack"
  fi
  for i in 1 2 3; do
    if dc --profile ops run --rm -T tool node /cost/seed/backfill-reports.js > "$OUT/backfill-1-$N-$run-try$i.log" 2>&1; then ok=1; break; fi
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
  local arm="$1" rep="$2" L used
  L="$arm-r$rep"
  case "$rep" in '' | *[!0-9]*) die "rep must be a number" ;; esac
  # Fail closed on label reuse: the scenarios select rows and files by label, so a second run under the same label would
  # merge with the first. Nothing is deleted; rerun under a new repetition number instead.
  # (ls exits 2 when a pattern matches nothing, which pipefail + set -e would turn into a silent exit of the arm)
  used="$(cd "$OUT" && { ls -d "idle-$L-"* "dq6-$L-"* 2>/dev/null || true; } | head -3 | tr '\n' ' ')"
  [ -z "$used" ] || die "arm $L already has results ($used...): rerun with a new repetition number"
  clock_guard
  set_arm "$arm"
  stamp "arm $L: start (rate ${RATE}/s, burst $BURST, idle ${IDLE_S}s)"
  ensure_flags off; record_mode "$L-idle-off"
  idle_window "$L-idle-off"
  ensure_flags on; record_mode "$L-idle-on"
  idle_window "$L-idle-on"
  # loaded: generator runs IDLE_S + 90 s; the resource window (IDLE_S) starts 15 s in, leaving 75 s for overrun
  stamp "arm $L: loaded"
  host_snapshot "$L-loaded start"
  clock_guard "$L-loaded"; mem_guard "$L-loaded"
  rm -f "$OUT/dq6-$L-loaded.gen-window.json" # a rerun must not reuse a stale coverage record
  node_env "$LOAD" steady "$L-loaded" --seconds $((IDLE_S + LOADED_EXTRA_S)) --rate "$RATE" > "$OUT/dq6-$L-loaded.log" 2>&1 &
  local gen=$!
  sleep 15
  bash "$M" idle "$L-loaded" "$IDLE_S"
  wait "$gen" || stamp "arm $L: loaded generator FAILED (dq6-$L-loaded.log)"
  host_snapshot "$L-loaded end"
  stamp "arm $L: loaded $(tail -1 "$OUT/dq6-$L-loaded.log" | cut -c1-300)"
  stamp "arm $L: burst"; bash "$M" drain "$L-burst"
  host_snapshot "$L-burst start"
  clock_guard "$L-burst"; mem_guard "$L-burst"
  node_env "$LOAD" burst "$L-burst" --notifications "$BURST" > "$OUT/dq6-$L-burst.log" 2>&1 || stamp "arm $L: burst FAILED"
  host_snapshot "$L-burst end"
  stamp "arm $L: burst $(tail -1 "$OUT/dq6-$L-burst.log" | cut -c1-300)"
  stamp "arm $L: Worker restart"
  host_snapshot "$L-rworker start"
  clock_guard "$L-rworker"; mem_guard "$L-rworker"
  node_env "$LOAD" recovery "$L-rworker" worker --rate "$REC_RATE" > "$OUT/dq6-$L-rworker.log" 2>&1 || stamp "arm $L: rworker FAILED"
  host_snapshot "$L-rworker end"
  stamp "arm $L: rworker $(tail -1 "$OUT/dq6-$L-rworker.log" | cut -c1-400)"
  ensure_flags on; bash "$M" drain "$L-rredis"
  stamp "arm $L: Redis restart"
  host_snapshot "$L-rredis start"
  clock_guard "$L-rredis"; mem_guard "$L-rredis"
  node_env "$LOAD" recovery "$L-rredis" redis --rate "$REC_RATE" > "$OUT/dq6-$L-rredis.log" 2>&1 || stamp "arm $L: rredis FAILED"
  host_snapshot "$L-rredis end"
  stamp "arm $L: rredis $(tail -1 "$OUT/dq6-$L-rredis.log" | cut -c1-400)"
  # Redis lost every BullMQ key and connection; recreate the API and Worker so the next arm starts from a clean process.
  hdocker_try rm -f costaudit-worker
  ensure_flags off
  clock_guard "the end of $L" # the last scenario ran inside the budget too
  stamp "arm $L: done"
}


# ---- D-Q6 realistic journeys (k6) -------------------------------------------------------------------------------------
# One dataset for every mode: k6prep copies the seeded database into the template rab_dq6seed; every k6arm drops `rab`,
# re-creates it from that template and restores the database-level state CREATE DATABASE does not copy (owner, ACL, the
# disposable marker), then verifies it against the record taken from the original (fail closed). Redis runs without
# persistence, so a stop/start empties it (no BullMQ job of an earlier arm survives).
K6_ORGS="${DQ6_K6_ORGS:-8}"
K6_WARM_S="${DQ6_K6_WARM_S:-60}"
K6_WIN_S="${DQ6_K6_WIN_S:-240}"
K6_TAIL_S="${DQ6_K6_TAIL_S:-20}"
K6_IDLE_S="${DQ6_K6_IDLE_S:-180}"
for v in "$K6_ORGS" "$K6_WARM_S" "$K6_WIN_S" "$K6_TAIL_S" "$K6_IDLE_S"; do case "$v" in '' | *[!0-9]*) die "DQ6_K6_* must be whole numbers" ;; esac; done
TEMPLATE_DB=rab_dq6seed
TEMPLATE_MARK="crewflow-cost disposable measurement TEMPLATE (dq6 k6)"
DB_MARK="crewflow-cost disposable measurement database"
# Superuser psql on the maintenance database of the disposable cluster (CREATE/DROP DATABASE cannot run inside `rab`).
qpg() { docker exec -i costaudit-pg psql -X -v ON_ERROR_STOP=1 -U rab -d postgres -Atq -c "$1"; }
db_marker() { qpg "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '$1'"; }
db_state() { # what CREATE DATABASE ... TEMPLATE does not carry over, for `rab`
  qpg "select 'owner=' || pg_get_userbyid(datdba) || ' acl=' || coalesce(datacl::text, '') || ' settings=' || (select count(*) from pg_db_role_setting s where s.setdatabase = d.oid) || ' marker=' || coalesce(shobj_description(oid, 'pg_database'), '') from pg_database d where datname = 'rab'"
}
stop_app() {
  hdocker_try stop costaudit-worker costaudit-api
  qpg "select count(pg_terminate_backend(pid)) from pg_stat_activity where datname in ('rab', '$TEMPLATE_DB') and pid <> pg_backend_pid()" > /dev/null
}

do_k6prep() {
  [ "$(db_marker rab)" = "$DB_MARK" ] || die "k6prep: costaudit-pg 'rab' does not carry the disposable marker"
  [ -z "$(qpg "select 1 from pg_database where datname = '$TEMPLATE_DB'")" ] || die "k6prep: $TEMPLATE_DB already exists (one template per stack; re-create the stack)"
  [ "$(q "select count(*) from core.organisation where slug like 'costaudit-%'")" -ge "$K6_ORGS" ] || die "k6prep: run setup first"
  psql_su < "$COST_DIR/k6/seed-teams.sql" > "$OUT/k6-seed-teams.txt"
  stamp "k6prep: $(tr '\n' ' ' < "$OUT/k6-seed-teams.txt")"
  q "vacuum analyze core.venue_manager_staff" > /dev/null
  db_state > "$OUT/k6-dbstate.txt"
  case "$(cat "$OUT/k6-dbstate.txt")" in *" settings=0 "*) ;; *) die "k6prep: database-level settings exist on rab; the restore does not carry them (refusing)" ;; esac
  stop_app
  local t=$SECONDS
  qpg "CREATE DATABASE $TEMPLATE_DB TEMPLATE rab STRATEGY FILE_COPY"
  qpg "COMMENT ON DATABASE $TEMPLATE_DB IS '$TEMPLATE_MARK'"
  stamp "k6prep: template $TEMPLATE_DB created in $((SECONDS - t)) s ($(qpg "select pg_size_pretty(pg_database_size('$TEMPLATE_DB'))")); $(cat "$OUT/k6-dbstate.txt")"
  # At most five long-running containers while k6 runs (pg, redis, api, worker + the k6p- generator): MinIO serves only
  # the seed's history backfill (done) and the 24 h storage-cleanup scan, so it is stopped for the k6 phase. Worker and
  # API error lines are counted per window (a storage call would show there). minio-init has exited; it is removed.
  hdocker_try rm -f costaudit-minio-init
  hdocker stop costaudit-minio
  set_k6_mode baseline
  ensure_flags off
}

restore_dataset() {
  [ "$(db_marker "$TEMPLATE_DB")" = "$TEMPLATE_MARK" ] || die "restore: template $TEMPLATE_DB missing or unmarked (run k6prep)"
  [ "$(db_marker rab)" = "$DB_MARK" ] || die "restore: 'rab' does not carry the disposable marker; refusing to drop it"
  local want owner acl t=$SECONDS
  want="$(cat "$OUT/k6-dbstate.txt")"
  owner="$(echo "$want" | sed -n 's/^owner=\([^ ]*\) .*/\1/p')"
  acl="$(echo "$want" | sed -n 's/.* acl=\([^ ]*\) settings=.*/\1/p')"
  [ -n "$owner" ] && [ -n "$acl" ] || die "restore: cannot read k6-dbstate.txt"
  stop_app
  qpg "DROP DATABASE rab WITH (FORCE)"
  qpg "CREATE DATABASE rab TEMPLATE $TEMPLATE_DB OWNER \"$owner\" STRATEGY FILE_COPY"
  qpg "COMMENT ON DATABASE rab IS '$DB_MARK'"
  # Disposable cluster, superuser: the ACL is copied back verbatim (GRANTs issued now would record another grantor).
  qpg "UPDATE pg_catalog.pg_database SET datacl = '$acl'::aclitem[] WHERE datname = 'rab'"
  [ "$(db_state)" = "$want" ] || die "restore: database state differs after the restore: got '$(db_state)', want '$want'"
  hdocker stop costaudit-redis
  hdocker start costaudit-redis
  for _ in $(seq 1 30); do [ "$(redis_cli PING 2>/dev/null | tr -d '\r')" = PONG ] && break; sleep 1; done
  [ "$(redis_cli DBSIZE | tr -d '\r')" = 0 ] || die "restore: Redis is not empty after its restart"
  stamp "restore: rab re-created from $TEMPLATE_DB in $((SECONDS - t)) s, Redis emptied"
}

set_k6_mode() { # baseline | combined | triggers  -> worker-env/base.env (Worker) + worker-env/api.env (API)
  unset COST_WORKER_CLAIM_MODE COST_WORKER_DISPATCH_MODE COST_WORKER_DB_USER COST_WORKER_DB_PW
  # main's production delivery settings (PR #84, docker-compose.production.yml), the same in every mode.
  printf 'WORKER_FAST_PUBLISH_NOTIFY=true\nWORKER_EMAIL_DISPATCH_INTERVAL_SECONDS=30\n' > "$OUT/worker-env/base.env"
  cp "$OUT/worker-env/base.env" "$OUT/worker-env/api.env"
  case "$1" in
    baseline) ;;
    combined)
      image_knows_combined || die "mode combined: crewflow-cost/worker:$COST_TAG has no WORKER_SHIFT_SCAN_MODE"
      echo "WORKER_SHIFT_SCAN_MODE=combined" >> "$OUT/worker-env/base.env" ;;
    triggers)
      echo "WORKER_TIMER_TRIGGERS=on" >> "$OUT/worker-env/base.env"
      echo "WORKER_TIMER_TRIGGERS=on" >> "$OUT/worker-env/api.env" ;;
    *) die "unknown k6 mode '$1' (baseline | combined | triggers)" ;;
  esac
  export COST_API_ENV_FILE
  COST_API_ENV_FILE="$(hostpath "$OUT/worker-env/api.env")"
}

k6_window() { # label [orgs]
  local L="$1" orgs="${2:-$K6_ORGS}" gen t0 at now since
  clock_guard "$L"; mem_guard "$L"
  since="$(date -u +%FT%TZ)"
  rm -f "$OUT/dq6-$L.gen-window.json"
  node_env "$COST_DIR/lib/k6-run.js" "$L" --orgs "$orgs" --warm "$K6_WARM_S" --win "$K6_WIN_S" --tail "$K6_TAIL_S" > "$OUT/dq6-$L.log" 2>&1 &
  gen=$!
  for _ in $(seq 1 300); do [ -f "$OUT/dq6-$L.k6-ready" ] && break; kill -0 "$gen" 2>/dev/null || break; sleep 1; done
  if [ ! -f "$OUT/dq6-$L.k6-ready" ]; then wait "$gen" || true; die "k6 $L never became ready: $(tail -3 "$OUT/dq6-$L.k6.log" 2>/dev/null | tr '\n' ' ') $(tail -2 "$OUT/dq6-$L.log" | tr '\n' ' ')"; fi
  t0="$(cat "$OUT/dq6-$L.k6-ready")"; at=$(( t0 / 1000 + K6_WARM_S )); now=$(date +%s)
  [ "$at" -le "$now" ] || sleep $(( at - now ))
  host_snapshot "$L start"; bash "$M" idle "$L" "$K6_WIN_S"; host_snapshot "$L end"
  wait "$gen" || stamp "k6 $L: generator exited non-zero (dq6-$L.log)"
  {
    for c in costaudit-worker costaudit-api; do echo "$c ERROR lines since $since: $(docker logs --since "$since" "$c" 2>&1 | grep -c ' ERROR ')"; done
    docker logs --since "$since" costaudit-worker 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g; s#(postgres(ql)?|redis)://[^ ]+#<url>#g' | grep ' ERROR ' | cut -c1-240 | sort | uniq -c | sort -rn | head -10
  } > "$OUT/dq6-$L.app-errors.txt" || true
  stamp "k6 $L: $(tail -1 "$OUT/dq6-$L.log" | cut -c1-300)"
}

do_k6arm() {
  local mode="$1" rep="$2" L used
  case "$rep" in '' | *[!0-9]*) die "rep must be a number" ;; esac
  L="$mode-r$rep"
  used="$(cd "$OUT" && { ls -d "idle-$L-"* "dq6-$L-"* 2>/dev/null || true; } | head -3 | tr '\n' ' ')"
  [ -z "$used" ] || die "k6arm $L already has results ($used...): rerun with a new repetition number"
  stamp "k6arm $L: start (orgs $K6_ORGS, idle ${K6_IDLE_S}s, k6 warm ${K6_WARM_S}s + window ${K6_WIN_S}s)"
  restore_dataset
  set_k6_mode "$mode"
  ensure_flags off; record_mode "$L-k6"
  IDLE_S="$K6_IDLE_S" idle_window "$L-k6idle"
  k6_window "$L-k6"
  clock_guard "the end of $L"
  stamp "k6arm $L: done"
}

do_k6smoke() { # functional check of the journeys on the current dataset: 2 organisations, short window, no verdict
  local L="smoke-$(date -u +%H%M%S)"
  set_k6_mode baseline; ensure_flags off
  K6_WARM_S=20 K6_WIN_S=90 K6_TAIL_S=5 k6_window "$L" 2
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
  k6prep) do_k6prep ;;
  k6smoke) do_k6smoke ;;
  k6arm) do_k6arm "${1:?mode}" "${2:?rep}" ;;
  k6abab)
    # NOT wrapped in heavy-run per arm (unlike abab): the caller holds ONE exclusive heavy-run window for all of it, so
    # every mode of a repetition sees the same host conditions back to back.
    modes="${1:?modes, e.g. \"baseline combined triggers\"}"; reps="${2:-2}"
    for r in $(seq 1 "$reps"); do
      for a in $modes; do do_k6arm "$a" "$r"; done
    done ;;
  *) die "unknown command $cmd" ;;
esac
