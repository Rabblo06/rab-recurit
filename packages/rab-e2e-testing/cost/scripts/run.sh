#!/usr/bin/env bash
# ONE command for a full, comparable cost/performance run against one commit, on a fresh disposable stack.
#
#   bash packages/rab-e2e-testing/cost/scripts/run.sh --commit <sha> --out <results dir> [options]
#   bash packages/rab-e2e-testing/cost/scripts/run.sh --check-isolation [--with-infra] [--out <dir>]
#
#   --commit <rev>        commit to measure (built from a clean `git archive`; default HEAD)
#   --tree <worktree>     instead of --commit: measure a worktree's CURRENT files (tracked as on disk + untracked-not-
#                         ignored) WITHOUT committing anything (scripts/tree-snapshot.sh; read-only on every repo; the
#                         main checkout is refused). Tag = tree-<content hash>; --out is required. The base commit, tree
#                         hash and file-list hash are recorded in <out>/tree.meta and versions.txt.
#   --tag <tag>           image tag (commit mode; default: 8-char sha) -> crewflow-cost/{server,worker}:<tag>. In tree
#                         mode only to resume with --only and no build phase (must equal the snapshot's tag).
#   --out <dir>           results directory (default $COST_WORK/out-<tag>; never inside the main checkout)
#   --skip-build          reuse existing crewflow-cost/*:<tag> images (tree mode reuses them automatically when the tree
#                         hash label matches)
#   --idle-seconds <s>    idle window length (default 600)
#   --no-heavy-run        do not wrap windows in C:/rab-ai-wt/setup/heavy-run.sh
#   --keep                leave the stack running at the end (default: guarded `down -v` of this project only)
#   --only <phases>       comma list of phases to run, in this order (default all): build,stack,idle0,seed5,idle5,seed20,
#                         storageboot,idle20,idleflags,provisioner,bootprobe,replicas,storage,endpoints,load,pdf,emails,
#                         shiftcycle,assemble. Use it to resume an interrupted run on the SAME stack. With --only the
#                         stack is not torn down; run `scripts/stack.sh down` yourself.
#   --skip <phases>       comma list of phases NOT to run (e.g. --skip load). Combines with --only.
#   --check-isolation     (alias --dry-run) run every isolation guard and exit; starts nothing (scripts/check-isolation.sh)
#                         With --tree <worktree> it also proves the tree snapshot read-only on that tree.
#   --with-infra          with --check-isolation: also start ONLY the harness infra (pg, redis, minio), re-check, and
#                         tear it down through the guarded `down`
#
# Phase A measurement options (identical values must be passed to the before and the after run):
#   --worker-env-file <f> KEY=VALUE lines added to the worker's environment for EVERY phase (copied to
#                         <out>/worker-env/base.env). Keys compose already sets for the worker are refused.
#   --flags-idle-seconds <s>   idleflags phase: idle window at O=20 with REALTIME_ENABLED=true PUSH_ENABLED=true
#                         (default: --idle-seconds). The default configuration (both false = code defaults = the production
#                         compose, which sets neither) is the idle20 window.
#   --prov-configs <list> provisioner phase: ';'-separated configurations name[:KEY=VALUE[,KEY=VALUE...]], one window each
#                         (default 'default' = base configuration only), e.g. 'default;off:X=false;on:X=true'.
#   --prov-seconds <s>    provisioner phase window length (default 300)
#   --boot-seconds <s>    bootprobe phase: observation window after a cold boot and after a restart (default 300)
#   --replica-seconds <s> replicas phase: observation window with two concurrently booting workers (default 300)
#   --replicas-env <kv>   replicas phase: extra KEY=VALUE[,KEY=VALUE...] for both replicas (e.g. a short storage-cleanup
#                         interval, so a leader lock has something to arbitrate when there is no boot-time reconcile)
#   COST_HEAVY_LABEL      heavy-run label for the windows (default p6)
#
# Isolation (README "Safety"): the harness never stops, restarts, removes or reconfigures a container, network or volume
# it did not create, and never mounts or writes the main checkout. Every run:
#   - preflight: static compose check, port/subnet check, paths outside the main checkout;
#   - records the main checkout (HEAD, porcelain status, yarn.lock + package.json hashes) and the dev containers' state;
#   - re-checks both after every phase. A main-checkout change ABORTS the run (exit 3) and names the changed paths in
#     <out>/main-checkout-drift-<phase>.txt; a dev-container change is reported in <out>/dev-containers-changes.log
#     (the harness never acts on them).
# Run it from a git worktree of this repo (heavy-run.sh refuses the main tree). Secrets: $COST_SECRETS (outside the
# repo; created by gen-secrets.sh on first use).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../lib/common.sh"

COMMIT=HEAD; COMMIT_SET=0; TREE=""; TAG=""; OUT=""; SKIP_BUILD=0; IDLE_S=600; HEAVY=1; KEEP=0; ONLY=""; SKIP=""; CHECK_ONLY=0; WITH_INFRA=0
WORKER_ENV_FILE=""; FLAGS_IDLE_S=""; PROV_CONFIGS="default"; PROV_S=300; BOOT_S=300; REPLICA_S=300; REPLICAS_ENV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; COMMIT_SET=1; shift 2 ;;
    --tree) TREE="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --worker-env-file) WORKER_ENV_FILE="$2"; shift 2 ;;
    --flags-idle-seconds) FLAGS_IDLE_S="$2"; shift 2 ;;
    --prov-configs) PROV_CONFIGS="$2"; shift 2 ;;
    --prov-seconds) PROV_S="$2"; shift 2 ;;
    --boot-seconds) BOOT_S="$2"; shift 2 ;;
    --replica-seconds) REPLICA_S="$2"; shift 2 ;;
    --replicas-env) REPLICAS_ENV="$2"; shift 2 ;;
    --idle-s3-trace) export COST_IDLE_S3_TRACE=1; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --idle-seconds) IDLE_S="$2"; shift 2 ;;
    --stop-dev) die "--stop-dev was removed on 2026-10-27: the harness never stops, restarts or reconfigures the dev stack. Run baseline and after back-to-back instead (README \"Comparability\")." ;;
    --no-heavy-run) HEAVY=0; shift ;;
    --keep) KEEP=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    --check-isolation | --dry-run) CHECK_ONLY=1; shift ;;
    --with-infra) WITH_INFRA=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
if [ "$CHECK_ONLY" = 1 ]; then
  args=()
  [ "$WITH_INFRA" = 1 ] && args+=(--with-infra)
  [ -n "$OUT" ] && args+=(--out "$OUT")
  [ -n "$TREE" ] && args+=(--tree "$TREE")
  exec bash "$HERE/check-isolation.sh" "${args[@]}"
fi
[ "$WITH_INFRA" = 0 ] || die "--with-infra only applies to --check-isolation"
for v in "$IDLE_S" "$PROV_S" "$BOOT_S" "$REPLICA_S" ${FLAGS_IDLE_S:+"$FLAGS_IDLE_S"}; do [[ "$v" =~ ^[1-9][0-9]*$ ]] || die "window lengths must be positive integers (got '$v')"; done
FLAGS_IDLE_S="${FLAGS_IDLE_S:-$IDLE_S}"

want() { { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; } && [[ ",$SKIP," != *",$1,"* ]]; }
if [ -n "$TREE" ]; then
  [ "$COMMIT_SET" = 0 ] || die "--tree and --commit are mutually exclusive"
  [ -n "$OUT" ] || die "--tree needs --out (the tag is a content hash, known only after the snapshot)"
  [ -d "$TREE" ] || die "--tree $TREE is not a directory"
  TREE="$(cd "$TREE" && pwd)"
  assert_outside_main "the tree to measure (--tree)" "$TREE"
  [ "$(norm_path "$TREE")" != "$(norm_path "$COST_MAIN_CHECKOUT")" ] || die "--tree: refusing the main checkout"
  FULL="$(GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$TREE")" rev-parse HEAD)"
  if want build; then COST_TAG="tree-pending"
  elif [ -n "$TAG" ]; then COST_TAG="$TAG"
  else die "--tree with --only/--skip excluding the build phase needs --tag tree-<hash> (see <out>/tree.meta)"; fi
  SOURCE="tree"
else
  FULL="$(GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$REPO")" rev-parse "${COMMIT}^{commit}")"
  COST_TAG="${TAG:-${FULL:0:8}}"
  SOURCE="commit"
fi
require_tag
OUT="${OUT:-$COST_WORK/out-$COST_TAG}"
assert_outside_main "the results directory (--out)" "$OUT"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"; export OUT COST_TAG
HEAVY_RUN="${COST_HEAVY_RUN:-/c/rab-ai-wt/setup/heavy-run.sh}"
M="$HERE/measure.sh"; S="$HERE/stack.sh"; GUARD="$OUT/guard"
cd "$REPO"
exec > >(tee -a "$OUT/run.log") 2>&1
log "run: source=$SOURCE ${TREE:+tree $TREE }commit $FULL tag $COST_TAG out $OUT idle ${IDLE_S}s heavy-run=$HEAVY label=${COST_HEAVY_LABEL:-p6} skip=${SKIP:-none} mode=shared-host (dev stack never touched)"
[ -f "$COST_SECRETS" ] || bash "$HERE/gen-secrets.sh"
load_secrets

# Worker base configuration for every phase (Phase A): <out>/worker-env/base.env, used by every worker (re)creation.
mkdir -p "$OUT/worker-env"
if [ -n "$WORKER_ENV_FILE" ]; then
  [ -f "$WORKER_ENV_FILE" ] || die "--worker-env-file $WORKER_ENV_FILE not found"
  { grep -vE '^[[:space:]]*(#|$)' "$WORKER_ENV_FILE" || true; } | tr -d '\r' > "$OUT/worker-env/base.env.new"
  ! grep -vqE '^[A-Z][A-Z0-9_]*=[^[:space:]]*$' "$OUT/worker-env/base.env.new" || die "--worker-env-file: every line must be KEY=VALUE without whitespace"
else
  : > "$OUT/worker-env/base.env.new"
fi
if [ -f "$OUT/worker-env/base.env" ] && ! cmp -s "$OUT/worker-env/base.env" "$OUT/worker-env/base.env.new"; then
  die "<out>/worker-env/base.env differs from this run's --worker-env-file; a resumed run must use the same worker configuration"
fi
mv "$OUT/worker-env/base.env.new" "$OUT/worker-env/base.env"
export COST_WORKER_ENV_FILE; COST_WORKER_ENV_FILE="$(hostpath "$OUT/worker-env/base.env")"
unset COST_REALTIME_ENABLED COST_PUSH_ENABLED
fixed_keys="$(COST_WORKER_ENV_FILE="$(hostpath "$COST_DIR/init/empty.env")" dc config --format json worker | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{const e=JSON.parse(r).services.worker.environment;console.log(Object.keys(e).join(" "))})')"
while IFS='=' read -r k _; do
  [ -n "$k" ] || continue
  [[ " $fixed_keys " != *" $k "* ]] || die "--worker-env-file: $k is set by docker-compose.cost.yml for the worker; an env-file value would be ignored"
done < "$OUT/worker-env/base.env"

# ---- isolation preflight and baselines ------------------------------------------------------------------------------
mkdir -p "$GUARD"
log "preflight: compose model, ports/subnet, main checkout $COST_MAIN_CHECKOUT"
check_compose_isolation > "$GUARD/compose-isolation.txt" || die "compose isolation check failed (see above)"
check_ports_subnet
rm -rf "$GUARD/main-checkout-start"; drift_snapshot "$GUARD/main-checkout-start"
devstate_snapshot > "$GUARD/dev-containers-start.tsv"
: > "$OUT/host-state.txt"; host_state_record "$OUT/host-state.txt" "run start"
log "main checkout baseline: $(head -1 "$GUARD/main-checkout-start/head.txt"), $(wc -l < "$GUARD/main-checkout-start/status.txt") status line(s), $(wc -l < "$GUARD/main-checkout-start/files.tsv") watched file(s)"
log "dev containers at start: $(awk -F'\t' '{printf "%s%s=%s", (NR>1?", ":""), $1, $2}' "$GUARD/dev-containers-start.tsv")"

# After every phase: dev-container state (report only) and main-checkout drift (abort).
checkpoint() {
  local ph="$1"
  devstate_check "$GUARD/dev-containers-start.tsv" "$ph" "$OUT" ||
    log "WARNING: dev container state changed (see dev-containers-changes.log); the harness did not act on them"
  host_state_record "$OUT/host-state.txt" "after $ph"
  if ! drift_check "$GUARD/main-checkout-start" "$ph" "$OUT"; then
    echo "$(date -u +%FT%TZ) ABORTED after phase '$ph': main checkout changed (main-checkout-drift-$ph.txt)" >> "$OUT/ABORTED.txt"
    echo "[cost] ABORT: the main checkout changed after phase '$ph' (paths above; saved in $OUT/main-checkout-drift-$ph.txt)." >&2
    echo "[cost] No further measurement runs. The harness stack is left for inspection; remove it with: COST_TAG=$COST_TAG bash $S down" >&2
    exit 3
  fi
  log "checkpoint $ph: main checkout unchanged"
}

# A window = one heavy-run token for exactly the duration of the measurement. Nothing else is stopped or started.
window() {
  local name="$1"; shift
  local rc=0
  if [ "$HEAVY" = 1 ]; then
    log "window $name: waiting for heavy-run token"
    bash "$HEAVY_RUN" "${COST_HEAVY_LABEL:-p6}" "$@" || rc=$?
  else
    "$@" || rc=$?
  fi
  [ "$rc" = 0 ] || die "window $name failed (exit $rc)"
}

trap 'hdocker_try unpause costaudit-worker' EXIT

if [ "$SOURCE" = tree ]; then
  if want build; then
    # Snapshot (read-only) + build, or reuse of images whose tree-hash label matches. Writes <out>/tree.meta.
    rm -f "$OUT/tree-tag.txt"
    window build bash "$HERE/build-images.sh" --tree "$TREE" --tag-file "$OUT/tree-tag.txt" --meta-out "$OUT/tree.meta"
    COST_TAG="$(cat "$OUT/tree-tag.txt")"; require_tag; export COST_TAG
    [ "$(sed -n 's/^baseCommit=//p' "$OUT/tree.meta")" = "$FULL" ] || die "the tree's HEAD moved between the start of the run and the snapshot"
  else
    [ -f "$OUT/tree.meta" ] || die "--tree resume without the build phase needs <out>/tree.meta from the original run"
    [ "$(sed -n 's/^tag=//p' "$OUT/tree.meta")" = "$COST_TAG" ] || die "--tag $COST_TAG does not match <out>/tree.meta"
  fi
  for i in server worker; do
    [ "$(docker image inspect -f '{{index .Config.Labels "crewflow-cost.tree-hash"}}' "crewflow-cost/$i:$COST_TAG" 2>/dev/null)" = "$(sed -n 's/^treeHash=//p' "$OUT/tree.meta")" ] ||
      die "crewflow-cost/$i:$COST_TAG is missing or does not carry the tree hash recorded in <out>/tree.meta"
  done
  log "tree mode: tag $COST_TAG, base commit $FULL, $(sed -n 's/^files=//p' "$OUT/tree.meta") files, $(sed -n 's/^statusLines=//p' "$OUT/tree.meta") git status line(s)"
elif want build; then
  if [ "$SKIP_BUILD" = 1 ] && docker image inspect "crewflow-cost/server:$COST_TAG" "crewflow-cost/worker:$COST_TAG" >/dev/null 2>&1; then
    log "reusing images crewflow-cost/{server,worker}:$COST_TAG"
  else
    window build bash "$HERE/build-images.sh" "$FULL" "$COST_TAG"
  fi
fi
LOADGEN_TAG="$(cat "$COST_DIR/tools/Dockerfile" "$COST_DIR/tools/package-lock.json" "$COST_DIR/tools/ac.js" | sha256sum | cut -c1-12)"
export COST_LOADGEN_IMAGE="crewflow-cost/loadgen:$LOADGEN_TAG"
docker image inspect "$COST_LOADGEN_IMAGE" >/dev/null 2>&1 || docker build -q -t "$COST_LOADGEN_IMAGE" "$(hostpath "$COST_DIR/tools")" >/dev/null
checkpoint build

if want stack; then
  log "fresh stack"
  bash "$S" down >/dev/null || die "pre-run teardown of the previous crewflow-cost stack was refused or failed"
  bash "$S" infra
  bash "$S" migrate
  bash "$S" api
  bash "$S" worker
  checkpoint stack
fi
# Flags-on idle window at the current O (Phase A acceptance): REALTIME_ENABLED + PUSH_ENABLED true on the API AND the
# worker, drain, window of --flags-idle-seconds, then both back to false. Runs after idle0, idle5 and idle20.
flags_window() {
  bash "$M" flags-up on
  bash "$M" drain "$1-flags-on"
  window "idle-$1-flags-on" bash "$M" idle "$1-flags-on" "$FLAGS_IDLE_S"
  bash "$M" flags-up off
  checkpoint "idleflags-$1"
}
if want idle0; then
  bash "$M" drain O0
  window idle-O0 bash "$M" idle O0 "$IDLE_S"
  checkpoint idle0
fi
if want idleflags && want idle0; then flags_window O0; fi
if want seed5; then
  hdocker stop costaudit-worker
  log "seed orgs 1-5"
  dc --profile ops run --rm -T -e ORG_FROM=1 -e ORG_TO=5 tool node /cost/seed/seed.js > "$OUT/seed-1-5.log" 2>&1 || die "seed 1-5 failed"
  dc --profile ops run --rm -T tool node /cost/seed/backfill-reports.js > "$OUT/backfill-1-5.log" 2>&1 || die "backfill failed"
  q "vacuum analyze" >/dev/null
  hdocker start costaudit-worker
  checkpoint seed5
fi
if want idle5; then
  bash "$M" drain O5
  window idle-O5 bash "$M" idle O5 "$IDLE_S"
  checkpoint idle5
fi
if want idleflags && want idle5; then flags_window O5; fi
if want seed20; then
  hdocker stop costaudit-worker
  log "seed orgs 6-20"
  dc --profile ops run --rm -T -e ORG_FROM=6 -e ORG_TO=20 tool node /cost/seed/seed.js > "$OUT/seed-6-20.log" 2>&1 || die "seed 6-20 failed"
  dc --profile ops run --rm -T tool node /cost/seed/backfill-reports.js > "$OUT/backfill-6-20.log" 2>&1 || die "backfill failed"
  q "vacuum analyze" >/dev/null
  log "uploads through the API (100 avatars, 20 venue photos)"
  node_env "$COST_DIR/lib/files.js" > "$OUT/files-upload.log" 2>&1 || die "uploads failed (see files-upload.log)"
  q "select relname||'|'||n_live_tup from pg_stat_user_tables where schemaname='core' and n_live_tup>0 order by n_live_tup desc" > "$OUT/rowcounts-after-seed.txt"
  q "select pg_size_pretty(pg_database_size('rab'))" >> "$OUT/rowcounts-after-seed.txt"
  checkpoint seed20
fi
# Worker (re)start with the S3 trace on: the boot-time storage reconcile is measured here.
if want storageboot; then window storage-boot bash "$M" storage-boot; checkpoint storageboot; fi
if want idle20; then
  bash "$M" drain O20
  window idle-O20 bash "$M" idle O20 "$IDLE_S"
  checkpoint idle20
fi
# ---- Phase A measurement phases (2026-10-27). Each one leaves costaudit-worker running on the base configuration. -----
# idleflags: flags-on idle windows (API + worker) at O=0, 5 and 20 (idle0/5/20 = both false); see flags_window.
if want idleflags; then flags_window O20; fi
# provisioner: one idle window per configuration; the provisioner's statements are those of the crewflow role.
if want provisioner; then
  IFS=';' read -ra PCFG <<< "$PROV_CONFIGS"
  for c in "${PCFG[@]}"; do
    [ -n "$c" ] || continue
    name="${c%%:*}"; kvs=""; [ "$name" = "$c" ] || kvs="${c#*:}"
    case "$name" in "" | *[!A-Za-z0-9_-]*) die "--prov-configs: bad configuration name '$name'" ;; esac
    # shellcheck disable=SC2086
    bash "$M" worker-up "prov-$name" ${kvs//,/ }
    if [ -f "$OUT/worker-env/prov-$name.REFUSED" ]; then
      log "provisioner configuration '$name': the worker refused to start; no window (worker-env/prov-$name.REFUSED)"
      continue
    fi
    bash "$M" drain "prov-$name"
    window "prov-$name" bash "$M" idle "prov-$name" "$PROV_S"
  done
  bash "$M" worker-up base
  checkpoint provisioner
fi
# bootprobe: cold boot, then graceful stop/start of the same container; time to ready/healthy, S3 + SQL in the first N s.
if want bootprobe; then
  bash "$M" drain boot
  window boot-cold bash "$M" boot-probe cold "$BOOT_S"
  window boot-restart bash "$M" boot-probe restart "$BOOT_S"
  checkpoint bootprobe
fi
# replicas: two workers booting concurrently (storage reconcile leader lock, S3 calls per replica).
if want replicas; then
  bash "$M" drain replicas
  # shellcheck disable=SC2086
  window replicas bash "$M" replicas "$REPLICA_S" ${REPLICAS_ENV//,/ }
  checkpoint replicas
fi
if want storage; then window storage-cli bash "$M" storage-cli; checkpoint storage; fi
if want endpoints; then window endpoints bash "$M" endpoints baseline; checkpoint endpoints; fi
if want load; then window load bash "$M" load baseline; checkpoint load; fi
if want pdf; then window pdf bash "$M" pdf; checkpoint pdf; fi
if want emails; then window emails bash "$M" emails; checkpoint emails; fi
if want shiftcycle; then window shift-cycle bash "$M" shift-cycle 20; checkpoint shiftcycle; fi

if want assemble; then
  # Versions and configuration actually used (no secrets), plus the host conditions the run shared.
  {
    echo "commit=$FULL"
    echo "source=$SOURCE"
    if [ "$SOURCE" = tree ]; then sed -n '/^## /q; s/^/tree./p' "$OUT/tree.meta"; fi
    for i in server worker; do echo "image.$i=crewflow-cost/$i:$COST_TAG $(docker image inspect -f '{{.Id}} {{.Created}}' "crewflow-cost/$i:$COST_TAG")"; done
    echo "image.loadgen=$COST_LOADGEN_IMAGE"
    echo "postgres=$(q 'show server_version')"
    echo "redis=$(redis_cli INFO server | tr -d '\r' | awk -F: '/^redis_version/{print $2}')"
    echo "minio=$(docker exec costaudit-minio minio --version 2>/dev/null | head -1)"
    echo "node.image=$(docker run --rm --label "$COST_HARNESS_LABEL=true" --entrypoint node "crewflow-cost/server:$COST_TAG" -v)"
    echo "chromium.image=$(docker run --rm --label "$COST_HARNESS_LABEL=true" --entrypoint sh "crewflow-cost/worker:$COST_TAG" -c 'chromium --version 2>/dev/null || chromium-browser --version' | head -1)"
    echo "autocannon=8.0.0"
    echo "docker=$(docker version -f '{{.Server.Version}}')"
    echo "vm.cpus=$(docker info -f '{{.NCPU}}') vm.memBytes=$(docker info -f '{{.MemTotal}}')"
    echo "limits.api=cpus ${COST_API_CPUS:-1} mem ${COST_API_MEM:-768m}; limits.worker=cpus ${COST_WORKER_CPUS:-1} mem ${COST_WORKER_MEM:-1g}; pg=no cpu limit, mem 1g; redis mem 256m; minio mem 384m; loadgen cpus ${COST_AC_CPUS:-2} mem 256m; pdf bench cpus 1 mem 1g"
    echo "flags=NODE_ENV=development HWS_RUNTIME_ENABLED=false WORKER_SCHEDULER=interval STORAGE_DRIVER=S3(MinIO) EMAIL_DRIVER=LOGGER REALTIME_ENABLED=false PUSH_ENABLED=false (worker; = code defaults = production compose, which sets neither) AI_ENABLED=false caches=default(off)"
    echo "phaseA.workerBaseEnvKeys=$(cut -d= -f1 "$OUT/worker-env/base.env" | tr '
' ' ')"
    echo "phaseA.flagsConfigs=idle-O0/O5/O20: REALTIME_ENABLED=false PUSH_ENABLED=false (API + worker); idle-O0/O5/O20-flags-on: REALTIME_ENABLED=true PUSH_ENABLED=true on the API AND the worker (${FLAGS_IDLE_S}s); idleS3Trace=${COST_IDLE_S3_TRACE:-0}"
    echo "phaseA.provConfigs=${PROV_CONFIGS} (${PROV_S}s each)"
    echo "phaseA.bootSeconds=${BOOT_S} replicaSeconds=${REPLICA_S} replicasEnv=${REPLICAS_ENV:-none}"
    echo "phaseA.workerConfigsUsed=$(cat "$OUT"/worker-env/*.config 2>/dev/null | tr '
' ' ' | head -c 3000)"
    echo "phasesSkipped=${SKIP:-none} only=${ONLY:-all}"
    echo "seed=COST_SEED_NOW=${COST_SEED_NOW:-2026-10-27T23:00:00Z} COST_SEED_RANDOM=${COST_SEED_RANDOM:-20261027} (translated to run hour; see seed-*.log first line)"
    echo "idleSeconds=$IDLE_S"
    echo "hostMode=shared-host (dev stack running and untouched; see host-state.txt and README \"Comparability\")"
    echo "devContainers.atStart=$(awk -F'\t' '{printf "%s%s:%s", (NR>1?",":""), $1, $2}' "$GUARD/dev-containers-start.tsv")"
    echo "devContainers.runningAtStart=$(awk -F'\t' '$2=="running"{printf "%s%s", (n++?",":""), $1}' "$GUARD/dev-containers-start.tsv")"
    echo "devContainers.changedDuringRun=$([ -f "$GUARD/dev-state-changed" ] && echo yes || echo no)"
    echo "otherContainers.runningAtStart=$(awk '/^# /{s++} s==1&&/^## running non-harness/{f=1;next} /^##/{f=0} f&&NF{split($0,a,"\t"); printf "%s%s", (n++?",":""), a[1]}' "$OUT/host-state.txt" | head -c 2000)"
    echo "mainCheckout=$COST_MAIN_CHECKOUT $(head -1 "$GUARD/main-checkout-start/head.txt") unchanged-through-last-checkpoint"
  } > "$OUT/versions.txt"
  node_env "$COST_DIR/lib/assemble.js" > "$OUT/assemble.log"
  log "results: $OUT/results.json"
fi
if [ "$KEEP" = 0 ] && [ -z "$ONLY" ]; then
  bash "$S" down >/dev/null && log "stack removed (guarded down -v of project crewflow-cost)"
fi
checkpoint end
log "run complete"
