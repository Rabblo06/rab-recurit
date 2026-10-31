#!/usr/bin/env bash
# Isolation self-check for the crewflow-cost harness. Measures nothing.
#
#   bash scripts/check-isolation.sh [--out <dir>] [--with-infra]
#   (also: bash scripts/run.sh --check-isolation [--with-infra] [--out <dir>])
#
# Default: starts NOTHING. Runs every guard read-only:
#   1 paths       harness folder, REPO, COST_WORK, COST_SECRETS and the out dir are outside the main checkout
#   2 compose     rendered compose model: binds read-only and inside the harness folder, never the main checkout;
#                 project volumes/network only; loopback ports that are not dev/test/e2e ports
#   3 ports       the four host ports and the subnet are not used by anything else
#   4 guard       the container guard refuses every dev container (inspect only, no docker verb is ever sent to them),
#                 refuses a costaudit-* container without the harness label (a decoy it creates and never starts),
#                 and passes an absent costaudit-* name; same for the Node guard in lib/lib.js
#   5 scope       every resource labelled com.docker.compose.project=crewflow-cost carries a harness name
#   6 drift       main-checkout snapshot, then an immediate re-check (must be unchanged)
#   7 devstate    dev-container snapshot, then a re-check (report only)
#  10 phase A   (2026-10-27) tree-snapshot mode refuses the main checkout (tree-snapshot.sh, build-images.sh --tree,
#                 run.sh --tree); the per-phase worker env helper refuses keys compose already sets and malformed lines and
#                 maps REALTIME_ENABLED/PUSH_ENABLED to the compose interpolation; the compose model with the second
#                 replica (profile replica) and a generated worker env file passes the static check.
#                 With --tree <worktree>: a real read-only snapshot of that tree into a temporary context (repo state
#                 digest before == after is asserted by the script), then the context is deleted. Builds nothing.
# --with-infra additionally starts ONLY the harness infra (costaudit-pg/redis/minio), checkpoints, tears it down
# through the guarded `stack.sh down`, verifies nothing labelled crewflow-cost is left, and checkpoints again.
# Exit 0 = every check passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../lib/common.sh"

OUT=""; WITH_INFRA=0; TREE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --tree) TREE="$2"; shift 2 ;;
    --with-infra) WITH_INFRA=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
OUT="${OUT:-$COST_WORK/check-isolation-$(date -u +%Y%m%dT%H%M%SZ)}"
assert_outside_main "the results directory (--out)" "$OUT"
mkdir -p "$OUT/guard"; OUT="$(cd "$OUT" && pwd)"; export OUT
export COST_TAG="${COST_TAG:-isolationcheck}"; require_tag
exec > >(tee -a "$OUT/check-isolation.log") 2>&1

PASS=0; FAIL=0
check() { # name cmd...
  local name="$1"; shift
  local tmp="$OUT/guard/.check.tmp"
  if ( "$@" ) > "$tmp" 2>&1; then
    PASS=$((PASS + 1)); echo "PASS  $name"
  else
    FAIL=$((FAIL + 1)); echo "FAIL  $name"
  fi
  sed 's/^/        /' "$tmp"; rm -f "$tmp"
}
expect_refused() { # name cmd...   (passes when the command is refused)
  local name="$1"; shift
  local tmp="$OUT/guard/.check.tmp"
  if ( "$@" ) > "$tmp" 2>&1; then
    FAIL=$((FAIL + 1)); echo "FAIL  $name (was NOT refused)"
  else
    PASS=$((PASS + 1)); echo "PASS  $name (refused)"
  fi
  sed 's/^/        /' "$tmp"; rm -f "$tmp"
}

echo "crewflow-cost isolation check $(date -u +%FT%TZ)"
echo "  main checkout   $COST_MAIN_CHECKOUT"
echo "  harness folder  $COST_DIR"
echo "  repo (archive)  $REPO"
echo "  work dir        $COST_WORK"
echo "  secrets         $COST_SECRETS (path only)"
echo "  out             $OUT"
echo "  mode            $([ "$WITH_INFRA" = 1 ] && echo 'with-infra (starts harness pg/redis/minio only, then tears them down)' || echo 'starts nothing')"
echo

# 1 paths (common.sh already refused at source time if any of these were inside the main checkout)
paths_ok() {
  local p
  for p in "$COST_DIR" "$REPO" "$COST_WORK" "$COST_SECRETS" "$OUT"; do
    assert_outside_main "$p" "$p"; echo "outside main checkout: $p"
  done
  [ "$(norm_path "$REPO")" != "$(norm_path "$COST_MAIN_CHECKOUT")" ] || die "REPO is the main checkout"
}
check "1 paths outside the main checkout" paths_ok

# 2 compose model
compose_ok() {
  [ -f "$COST_SECRETS" ] || die "secrets file missing ($COST_SECRETS); run scripts/gen-secrets.sh first"
  load_secrets
  check_compose_isolation
}
check "2 compose model isolated (no main-checkout or writable binds, own volumes/network, loopback non-dev ports)" compose_ok

# 3 ports / subnet
check "3 ports $COST_PG_PORT/$COST_REDIS_PORT/$COST_MINIO_PORT/$COST_API_PORT and subnet $COST_SUBNET unused by others" check_ports_subnet

# 4 container guard
mapfile -t DEV < <(docker ps -a --format '{{.Names}}' | grep -E "$COST_DEV_WATCH_REGEX" | sort || true)
for n in "${DEV[@]}"; do
  expect_refused "4 container guard refuses dev container $n (inspect only)" assert_harness_container "$n"
done
expect_refused "4 container guard refuses a non-costaudit name before any docker verb (hdocker stop rab-guardtest-absent)" hdocker stop rab-guardtest-absent
expect_refused "4 container guard refuses a disallowed verb (hdocker kill)" hdocker kill costaudit-guardtest-absent
check "4 container guard passes an absent costaudit-* name (nothing to act on)" assert_harness_container costaudit-guardtest-absent
DECOY_IMG=redis:7-alpine
if docker image inspect "$DECOY_IMG" >/dev/null 2>&1; then
  # A costaudit-* name WITHOUT the harness/project label must be refused. Created (never started) by this check with its
  # own decoy label, and removed only after that exact label is verified.
  # Keyed on the exit code: for a missing container docker prints an empty line before failing.
  decoy_label() { local v; if v="$(docker container inspect -f '{{index .Config.Labels "crewflow-cost.guard-decoy"}}' costaudit-guard-decoy 2>/dev/null)"; then printf '%s' "$v"; else printf absent; fi; }
  case "$(decoy_label)" in
    absent) ;;
    true) docker rm costaudit-guard-decoy >/dev/null ;; # a leftover decoy of an earlier check
    *) die "a container named costaudit-guard-decoy exists without the decoy label; not touching it" ;;
  esac
  docker create --name costaudit-guard-decoy --label crewflow-cost.guard-decoy=true "$DECOY_IMG" >/dev/null
  expect_refused "4 container guard refuses costaudit-guard-decoy (costaudit- name, no harness label)" assert_harness_container costaudit-guard-decoy
  [ "$(decoy_label)" = true ] && docker rm costaudit-guard-decoy >/dev/null
else
  echo "SKIP  4 decoy test ($DECOY_IMG not present locally; not pulling)"
fi
node_guard() {
  COST_SECRETS="$(hostpath "$COST_SECRETS")" COST_OUT="$(hostpath "$OUT/guard")" node -e '
    const { assertHarnessContainer } = require(process.argv[1]);
    let bad = 0;
    for (const n of process.argv.slice(2)) {
      try { assertHarnessContainer(n); console.log(`NOT refused: ${n}`); bad++; } catch (e) { console.log(`refused: ${n}`); }
    }
    try { assertHarnessContainer("costaudit-guardtest-absent"); console.log("absent costaudit-guardtest-absent: passes"); } catch (e) { console.log("absent name wrongly refused"); bad++; }
    process.exit(bad ? 1 : 0);
  ' "$(hostpath "$COST_DIR/lib/lib.js")" "${DEV[@]}" rab-guardtest-absent
}
check "4 Node container guard (lib/lib.js) refuses every dev container" node_guard

# 5 project scope
scope_ok() {
  assert_project_scope
  echo "resources labelled com.docker.compose.project=$COST_PROJECT:"
  docker ps -a --filter "label=com.docker.compose.project=$COST_PROJECT" --format '  container {{.Names}} ({{.Status}})'
  docker volume ls --filter "label=com.docker.compose.project=$COST_PROJECT" --format '  volume {{.Name}}'
  docker network ls --filter "label=com.docker.compose.project=$COST_PROJECT" --format '  network {{.Name}}'
}
check "5 project scope: everything labelled $COST_PROJECT has a harness name" scope_ok

# 6 drift guard baseline + immediate re-check; 7 dev-state baseline + re-check
rm -rf "$OUT/guard/main-checkout-start"
drift_snapshot "$OUT/guard/main-checkout-start"
devstate_snapshot > "$OUT/guard/dev-containers-start.tsv"
: > "$OUT/host-state.txt"; host_state_record "$OUT/host-state.txt" "check start"
drift_summary() {
  echo "$(head -1 "$OUT/guard/main-checkout-start/head.txt"); $(tail -1 "$OUT/guard/main-checkout-start/head.txt")"
  echo "status lines: $(wc -l < "$OUT/guard/main-checkout-start/status.txt"); watched files: $(wc -l < "$OUT/guard/main-checkout-start/files.tsv")"
  grep -E '^yarn\.lock	' "$OUT/guard/main-checkout-start/files.tsv" | awk -F'\t' '{print "yarn.lock size " $2 " sha256 " substr($3,1,16) "..."}'
  drift_check "$OUT/guard/main-checkout-start" check-immediate "$OUT"
}
check "6 main-checkout drift guard: baseline recorded, re-check unchanged" drift_summary
devstate_summary() {
  sed 's/^/dev container: /' "$OUT/guard/dev-containers-start.tsv"
  devstate_check "$OUT/guard/dev-containers-start.tsv" check-immediate "$OUT"
}
check "7 dev-container state guard: baseline recorded, re-check unchanged (report only)" devstate_summary

if [ "$WITH_INFRA" = 1 ]; then
  infra_up() { bash "$HERE/stack.sh" infra; docker ps --filter "label=com.docker.compose.project=$COST_PROJECT" --format 'running: {{.Names}} {{.Ports}}'; }
  check "8 harness infra up (costaudit-pg/redis/minio only)" infra_up
  check "8 drift guard after infra up" drift_check "$OUT/guard/main-checkout-start" infra-up "$OUT"
  check "8 dev-container state after infra up" devstate_check "$OUT/guard/dev-containers-start.tsv" infra-up "$OUT"
  check "8 project scope before teardown" scope_ok
  infra_down() {
    bash "$HERE/stack.sh" down
    local left
    left="$(docker ps -a --filter "label=com.docker.compose.project=$COST_PROJECT" --format '{{.Names}}'; docker volume ls --filter "label=com.docker.compose.project=$COST_PROJECT" --format '{{.Name}}'; docker network ls --filter "label=com.docker.compose.project=$COST_PROJECT" --format '{{.Name}}')"
    [ -z "$left" ] || die "left behind after down: $left"
    echo "nothing labelled $COST_PROJECT remains"
  }
  check "8 guarded teardown removes only the harness project" infra_down
  host_state_record "$OUT/host-state.txt" "after infra teardown"
fi

# 10 Phase A additions
expect_refused "10 tree-snapshot.sh refuses the main checkout ($COST_MAIN_CHECKOUT)" bash "$HERE/tree-snapshot.sh" "$COST_MAIN_CHECKOUT" "$OUT/guard/tree-refuse-ctx" "$OUT/guard/tree-refuse.meta"
expect_refused "10 tree-snapshot.sh refuses a directory inside the main checkout" bash "$HERE/tree-snapshot.sh" "$COST_MAIN_CHECKOUT/packages" "$OUT/guard/tree-refuse-ctx" "$OUT/guard/tree-refuse.meta"
expect_refused "10 build-images.sh --tree refuses the main checkout" bash "$HERE/build-images.sh" --tree "$COST_MAIN_CHECKOUT"
expect_refused "10 run.sh --tree refuses the main checkout" bash "$HERE/run.sh" --tree "$COST_MAIN_CHECKOUT" --out "$OUT/guard/tree-refuse-run" --only assemble --tag tree-000000000000
expect_refused "10 build-images.sh refuses a commit build into the tree-* tag namespace" bash "$HERE/build-images.sh" HEAD tree-000000000000
wenv_tests() {
  load_secrets
  . "$COST_DIR/lib/worker-env.sh"
  local OUT="$OUT/guard/wenv-test"; rm -rf "$OUT"; mkdir -p "$OUT"
  ( make_worker_env t1 PG_DATABASE_URL=postgres://x ) >/dev/null 2>&1 && die "DATABASE_URL (compose-set) was NOT refused"
  echo "refused: PG_DATABASE_URL (set by compose for the worker)"
  ( make_worker_env t2 STORAGE_DRIVER=LOCAL ) >/dev/null 2>&1 && die "STORAGE_DRIVER (compose-set) was NOT refused"
  echo "refused: STORAGE_DRIVER (set by compose for the worker)"
  ( make_worker_env t3 'BAD KEY=1' ) >/dev/null 2>&1 && die "malformed assignment was NOT refused"
  echo "refused: malformed assignment"
  ( make_worker_env 'bad/name' X=1 ) >/dev/null 2>&1 && die "bad configuration name was NOT refused"
  echo "refused: configuration name with a slash"
  make_worker_env t4 REALTIME_ENABLED=true PUSH_ENABLED=true PHASEA_TEST_SWITCH=true
  [ "$WRT/$WPU" = true/true ] || die "REALTIME/PUSH not mapped to the compose interpolation"
  [ "$(cat "$WENV")" = "PHASEA_TEST_SWITCH=true" ] || die "env file content unexpected"
  echo "accepted: REALTIME_ENABLED/PUSH_ENABLED -> interpolation, PHASEA_TEST_SWITCH -> env file"
  ( make_worker_env t5 -PG_DATABASE_URL ) >/dev/null 2>&1 && die "removing a compose-set key was NOT refused"
  echo "refused: -PG_DATABASE_URL (compose-set keys cannot be removed)"
  printf 'PHASEA_A=1\nPHASEA_B=2\n' > "$OUT/worker-env/base.env"
  make_worker_env t6 -PHASEA_A PHASEA_B=3 -CREWFLOW_PROVISIONER_DATABASE_URL
  [ "$(cat "$WENV")" = "PHASEA_B=3" ] && [ "$WNOURL" = 1 ] || die "removal/override not applied ($(tr '\n' ' ' < "$WENV"), WNOURL=$WNOURL)"
  echo "accepted: -KEY removes a base.env key, KEY=VALUE overrides it, -CREWFLOW_PROVISIONER_DATABASE_URL sets WNOURL"
  ( COST_NO_PROVISIONER_URL=1 load_secrets; wdc config --format json worker ) | node -e '
    let r = ""; process.stdin.on("data", (d) => (r += d)).on("end", () => { const e = JSON.parse(r).services.worker.environment;
      const v = e.CREWFLOW_PROVISIONER_DATABASE_URL; console.log("without: provisioner URL in the rendered worker env = " + (v == null ? "no value (not passed to the container)" : "SET")); process.exit(v == null ? 0 : 1); });'
  make_worker_env t7
  wdc config --format json worker | node -e '
    let r = ""; process.stdin.on("data", (d) => (r += d)).on("end", () => { const v = JSON.parse(r).services.worker.environment.CREWFLOW_PROVISIONER_DATABASE_URL;
      const ok = typeof v === "string" && /^postgres:\/\/crewflow:[^@]+@pg:5432\/rab$/.test(v); console.log("default: provisioner URL rendered as postgres://crewflow:***@pg:5432/rab = " + ok); process.exit(ok ? 0 : 1); });'
  : > "$OUT/worker-env/base.env"
  make_worker_env t4 REALTIME_ENABLED=true PUSH_ENABLED=true PHASEA_TEST_SWITCH=true
  COST_WORKER_ENV_FILE="$(hostpath "$WENV")" COST_REALTIME_ENABLED=true COST_PUSH_ENABLED=true check_compose_isolation | tail -1
  COST_WORKER_ENV_FILE="$(hostpath "$WENV")" COST_REALTIME_ENABLED=true COST_PUSH_ENABLED=true dc --profile replica config --format json | node -e '
    let r = ""; process.stdin.on("data", (d) => (r += d)).on("end", () => {
      const m = JSON.parse(r); let bad = 0;
      for (const s of ["worker", "worker2"]) { const e = m.services[s].environment;
        const ok = e.PHASEA_TEST_SWITCH === "true" && e.REALTIME_ENABLED === "true" && e.PUSH_ENABLED === "true";
        console.log(s + " (" + m.services[s].container_name + "): env-file key and flags rendered: " + ok); if (!ok) bad++; }
      if (m.services.api.environment.PUSH_ENABLED !== "true" || m.services.api.environment.REALTIME_ENABLED !== "true") { console.log("api does NOT follow the flags"); bad++; } else console.log("api follows the flags (flags-up recreates it)");
      process.exit(bad ? 1 : 0); });'
}
check "10 worker env helper: refusals, flag mapping, compose model with worker2 + env file" wenv_tests
if [ -n "$TREE" ]; then
  tree_snapshot_ro() {
    local ctx="$COST_WORK/build/isolation-tree-snap-$" meta="$OUT/guard/tree-snapshot.meta" tag
    tag="$(bash "$HERE/tree-snapshot.sh" "$TREE" "$ctx" "$meta")"
    rm -rf "$ctx"
    echo "tag $tag (context deleted; nothing built)"
    sed -n '/^## /q; p' "$meta"
    drift_check "$OUT/guard/main-checkout-start" tree-snapshot "$OUT"
  }
  check "10 tree snapshot of $TREE is read-only (repo state digest unchanged) and leaves the main checkout unchanged" tree_snapshot_ro
fi

check "9 final: main checkout unchanged across the whole check" drift_check "$OUT/guard/main-checkout-start" final "$OUT"
check "9 final: dev containers unchanged across the whole check (report only)" devstate_check "$OUT/guard/dev-containers-start.tsv" final "$OUT"

echo
echo "isolation check: $PASS passed, $FAIL failed (log: $OUT/check-isolation.log)"
[ "$FAIL" = 0 ]
