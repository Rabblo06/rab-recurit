#!/usr/bin/env bash
# Phase C1 screen-traffic measurement: ONE command for the "before" and the "after" run.
#
#   bash packages/rab-e2e-testing/cost/screen-traffic/run.sh --commit 614796f0 \
#        --schedule schedules/before-614796f0.mjs --front /c/rab-ai-wt/m2/packages/rab-front \
#        --out /c/rab-ai-wt/cost-work/results/c1-before
#   (after: --tree /c/rab-ai-wt/c1 or --commit <sha>, --schedule schedules/after-<x>.mjs, --front /c/rab-ai-wt/c1/packages/rab-front)
#
# Phases (--only a,b,c to run a subset on an existing stack; default all):
#   stack    harness run.sh --only build,stack,seed5,seed20: images (reused if present), fresh disposable stack, migrations,
#            deterministic 20-org seed + history backfill + API uploads. Every harness isolation guard applies.
#   seed     seed-screen-traffic.sh (venue requests + one platform admin)
#   server   load windows (run-load.mjs) each measured by the harness's `measure.sh idle` (pg_stat_statements, cgroup
#            CPU, docker stats, Redis) and joined with the API's per-request SQL log (analyze.mjs):
#              mix-visible  every screen of the mix, foreground/visible   (--window-s, default 600)
#              mix-hidden   every screen of the mix, app backgrounded / tab hidden (--hidden-window-s, default 300)
#              idle-baseline no load at all (worker background only; --solo-window-s)
#              solo-<screen> one window per screen with only that screen's users (--solo-window-s, default 120)
#   web      Playwright against a host Vite of --front pointed at the harness API (web/measure-web.mjs)
#   down     guarded teardown of the crewflow-cost project (skipped with --keep)
# Each window runs inside heavy-run (label $COST_HEAVY_LABEL, default c1-f0). Host conditions (free RAM, heavy-run
# token owners, running containers) are recorded before every window in <out>/host-conditions.log.
set -euo pipefail
ST="$(cd "$(dirname "$0")" && pwd)"
. "$ST/../lib/common.sh"
export COST_HEAVY_LABEL="${COST_HEAVY_LABEL:-c1-f0}"
HEAVY_RUN="${COST_HEAVY_RUN:-/c/rab-ai-wt/setup/heavy-run.sh}"
# The real web client is served by a host Vite on 127.0.0.1:23173 (web/vite.config.mjs); the API must accept that Origin.
export COST_CORS_ORIGINS="http://127.0.0.1:5173,http://127.0.0.1:23173"

if [ "${1:-}" = "--internal-window" ]; then
  # Re-entered through heavy-run: one load window. Args: label state seconds warmup only-screen(or -)
  shift; L="$1"; S="$2"; D="$3"; WARM="$4"; ONLY="$5"
  : "${OUT:?}" "${SCHED:?}" "${MIX:?}" "${COST_TAG:?}"
  rm -f "$OUT/ready-$L"
  since="$(date -u +%FT%TZ)"
  args=(--schedule "$(hostpath "$SCHED")" --mix "$(hostpath "$MIX")" --out "$(hostpath "$OUT")" --label "$L" --warmup-s "$WARM" --phases "$S:$((D + 25))" --ready-file "$(hostpath "$OUT/ready-$L")")
  [ "$ONLY" = "-" ] || args+=(--only-screen "$ONLY")
  COST_SECRETS="$(hostpath "$COST_SECRETS")" node "$(hostpath "$ST/run-load.mjs")" "${args[@]}" > "$OUT/load-$L.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 $((WARM + 300))); do [ -f "$OUT/ready-$L" ] && break; kill -0 "$pid" 2>/dev/null || { cat "$OUT/load-$L.log" >&2; die "load generator for $L exited early"; }; sleep 1; done
  [ -f "$OUT/ready-$L" ] || die "load generator for $L never became ready"
  sleep 5
  bash "$COST_DIR/scripts/measure.sh" idle "st-$L" "$D"
  wait "$pid" || { cat "$OUT/load-$L.log" >&2; die "load generator for $L failed"; }
  node "$(hostpath "$ST/lib/api-sql.mjs")" "$since" "$(hostpath "$OUT/api-sql-$L.json")" >> "$OUT/load-$L.log"
  node "$(hostpath "$ST/analyze.mjs")" "$(hostpath "$OUT")" "$L" > /dev/null
  log "window $L ($S, ${D}s) done: $(head -c 300 "$OUT/load-$L.log" | head -1)"
  exit 0
fi

COMMIT=""; TREE=""; IMAGE_TAG=""; SCHED=""; MIX="$ST/mixes/c1-mix.mjs"; OUT=""; FRONT="/c/rab-ai-wt/m2/packages/rab-front"; ONLY=""; KEEP=0
WIN=600; HWIN=300; SWIN=120; WARM=60; SOLO="vm-sent-shifts-flutter,vm-sent-shifts-ios,staff-home-flutter,staff-job-details-flutter,staff-home-ios,web-venue-offer-pipeline,web-venue-offers,web-admin-health"
WEB_ARGS=(); SW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --tree) TREE="$2"; shift 2 ;;
    --image-tag) IMAGE_TAG="$2"; shift 2 ;;
    --schedule) SCHED="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --mix) MIX="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --front) FRONT="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --window-s) WIN="$2"; shift 2 ;;
    --hidden-window-s) HWIN="$2"; shift 2 ;;
    --solo-window-s) SWIN="$2"; shift 2 ;;
    --warmup-s) WARM="$2"; shift 2 ;;
    --solo) SOLO="$2"; shift 2 ;;
    --windows) SW="$2"; shift 2 ;;
    --web-window-s) WEB_ARGS+=(--window-s "$2"); shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[ -n "$OUT" ] || die "--out is required"
[ -n "$SCHED" ] && [ -f "$SCHED" ] || die "--schedule <file> is required"
[ -n "$COMMIT" ] || [ -n "$TREE" ] || [ -n "$IMAGE_TAG" ] || die "--commit <sha>, --tree <worktree> or --image-tag <tag> is required"
assert_outside_main "the results directory (--out)" "$OUT"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"; export OUT SCHED MIX
want() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }
# --windows idle-baseline,mix-visible,solo-<screen>,...: re-run only these server windows (default: all)
wantw() { [ -z "$SW" ] || [[ ",$SW," == *",$1,"* ]]; }
exec > >(tee -a "$OUT/screen-traffic-run.log") 2>&1
HARNESS_OUT="$OUT/harness"

host_conditions() { # <label>
  {
    echo "## $(date -u +%FT%TZ) $1"
    echo "hostFreeMB=$(powershell.exe -NoProfile -Command '[int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)' 2>/dev/null | tr -d '\r')"
    for t in heavy-1 heavy-2; do echo "$t=$(cat "/c/rab-ai-wt/.locks/$t/owner" 2>/dev/null | tr -d '\n' || echo free)"; done
    echo "queue=$(ls -1 /c/rab-ai-wt/.locks/queue 2>/dev/null | tr '\n' ' ')"
    docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null
  } >> "$OUT/host-conditions.log"
}

log "screen-traffic: ${IMAGE_TAG:+images $IMAGE_TAG }${COMMIT:+commit $COMMIT}${TREE:+tree $TREE} schedule $(basename "$SCHED") mix $(basename "$MIX") out $OUT"
host_conditions "start"
if want stack; then
  # Build (or reuse) the images in their own heavy-run, then stack + seed in another, with the harness's own windows
  # disabled (--no-heavy-run) so heavy-run is never nested.
  mkdir -p "$HARNESS_OUT"
  args=(--only stack,seed5,seed20 --out "$HARNESS_OUT" --no-heavy-run)
  if [ -n "$IMAGE_TAG" ]; then
    # Pre-built images (e.g. retagged from rab-{server,worker}:<x>): never built here; the harness records HEAD as the commit.
    docker image inspect "crewflow-cost/server:$IMAGE_TAG" "crewflow-cost/worker:$IMAGE_TAG" >/dev/null || die "crewflow-cost/{server,worker}:$IMAGE_TAG missing"
    args+=(--commit HEAD --tag "$IMAGE_TAG")
  elif [ -n "$TREE" ]; then
    host_conditions "build"
    bash "$HEAVY_RUN" "$COST_HEAVY_LABEL" bash "$COST_DIR/scripts/build-images.sh" --tree "$TREE" --tag-file "$HARNESS_OUT/tree-tag.txt" --meta-out "$HARNESS_OUT/tree.meta"
    args+=(--tree "$TREE" --tag "$(cat "$HARNESS_OUT/tree-tag.txt")")
  else
    tag="$(GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$REPO")" rev-parse "${COMMIT}^{commit}" | cut -c1-8)"
    if ! docker image inspect "crewflow-cost/server:$tag" "crewflow-cost/worker:$tag" >/dev/null 2>&1; then
      host_conditions "build"
      bash "$HEAVY_RUN" "$COST_HEAVY_LABEL" bash "$COST_DIR/scripts/build-images.sh" "$COMMIT"
    fi
    args+=(--commit "$COMMIT")
  fi
  host_conditions "stack"
  bash "$HEAVY_RUN" "$COST_HEAVY_LABEL" bash "$COST_DIR/scripts/run.sh" "${args[@]}"
fi
# The image tag of the running stack (commit sha8 or tree-<hash>), recorded by the harness.
if [ -n "$IMAGE_TAG" ]; then COST_TAG="$IMAGE_TAG"; elif [ -n "$TREE" ]; then COST_TAG="$(sed -n 's/^tag=//p' "$HARNESS_OUT/tree.meta")"; else COST_TAG="$(GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$REPO")" rev-parse "${COMMIT}^{commit}" | cut -c1-8)"; fi
export COST_TAG
[ "$(docker inspect -f '{{.Config.Image}}' costaudit-api 2>/dev/null)" = "crewflow-cost/server:$COST_TAG" ] || die "costaudit-api is not running crewflow-cost/server:$COST_TAG"
{ echo "tag=$COST_TAG"; echo "schedule=$(basename "$SCHED") sha256=$(sha256sum "$SCHED" | cut -c1-16)"; echo "mix=$(basename "$MIX") sha256=$(sha256sum "$MIX" | cut -c1-16)"; echo "engine sha256=$(cat "$ST/lib/engine.mjs" "$ST/run-load.mjs" | sha256sum | cut -c1-16)"; echo "front=$FRONT"; for i in server worker; do echo "image.$i=$(docker image inspect -f "{{.Id}} {{.Created}}" crewflow-cost/$i:$COST_TAG)"; done; } > "$OUT/screen-traffic-meta.txt"

# The harness seed20 phase leaves the worker STOPPED (its storageboot phase normally recreates it); the polling windows
# measure a running stack, so start it here (idempotent; compose recreates nothing if it is already running).
if want stack || want server; then OUT="$HARNESS_OUT" bash "$COST_DIR/scripts/stack.sh" worker; fi
if want seed; then bash "$ST/seed-screen-traffic.sh"; fi

window() { # label state seconds only-screen
  host_conditions "window $1"
  bash "$HEAVY_RUN" "$COST_HEAVY_LABEL" bash "$ST/run.sh" --internal-window "$1" "$2" "$3" "$4" "$5"
}
if want server; then
  [ -n "$SW" ] || bash "$COST_DIR/scripts/measure.sh" drain st-before-windows
  # No-load control: the worker's own background SQL/CPU, to subtract from every window (solo windows especially).
  if wantw idle-baseline; then host_conditions "window idle-baseline"; bash "$HEAVY_RUN" "$COST_HEAVY_LABEL" bash "$COST_DIR/scripts/measure.sh" idle st-idle-baseline "$SWIN"; fi
  wantw mix-visible && window mix-visible visible "$WIN" "$WARM" -
  wantw mix-hidden && window mix-hidden hidden "$HWIN" "$WARM" -
  IFS=',' read -ra SOLOS <<< "$SOLO"
  for s in "${SOLOS[@]}"; do [ -n "$s" ] && wantw "solo-$s" && window "solo-$s" visible "$SWIN" 30 "$s"; done
fi
if want web; then
  host_conditions "web"
  bash "$HEAVY_RUN" "$COST_HEAVY_LABEL" node "$(hostpath "$ST/web/measure-web.mjs")" --front "$(hostpath "$FRONT")" --out "$(hostpath "$OUT/web")" "${WEB_ARGS[@]}"
fi
if want down && [ "$KEEP" = 0 ]; then
  bash "$COST_DIR/scripts/stack.sh" down >/dev/null && log "harness stack removed"
fi
node "$(hostpath "$ST/report.mjs")" "$(hostpath "$OUT")" > /dev/null 2>&1 || log "report.mjs: nothing to assemble yet"
host_conditions "end"
log "screen-traffic run complete: $OUT"
