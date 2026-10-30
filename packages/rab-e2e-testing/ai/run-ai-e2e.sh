#!/usr/bin/env bash
# AI full-flow E2E on a disposable stack this script starts and stops itself:
#   the API from SOURCE through the TEST-ONLY boot (boot-api.e2e.ts) on :3998, the rab-ai consumer from SOURCE through the
#   TEST-ONLY boot (boot-worker.e2e.ts), Vite on :5176, against crewflow-test-db (127.0.0.1:15436) and a disposable test
#   Redis (crewflow-test-redis 127.0.0.1:16391, or an AI-build agent's own container 127.0.0.1:16392-16399; db index 9),
#   AI_ENABLED=true, NODE_ENV=test. The deterministic model comes from the test catalogue + model-factory seams of
#   helpers/ai-test-kit.ts (Test.createTestingModule().overrideProvider) — the mock is test-only and is NOT in dist, and
#   the retired AI_PROVIDER / AI_MODEL are not set. Synthetic organisations only.
# Never the owner's docker `rab` stack, rab-devdb (127.0.0.1:15432), Neon or production.
#
# Usage: AI_E2E_ENV=<file with TEST_DATABASE_URL, TEST_DATABASE_URL_UNPOOLED, REDIS_URL, APP_SECRET> \
#        AI_E2E_WORK=<scratch dir for logs, identities, evidence> packages/rab-e2e-testing/ai/run-ai-e2e.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
: "${AI_E2E_ENV:?set AI_E2E_ENV to the disposable test env file}"
: "${AI_E2E_WORK:?set AI_E2E_WORK to a scratch directory}"
mkdir -p "$AI_E2E_WORK"
API_PORT="${AI_E2E_API_PORT:-3998}"
WEB_PORT="${AI_E2E_WEB_PORT:-5176}"
WEB="http://localhost:${WEB_PORT}"
API="http://localhost:${API_PORT}/rest/v1"

set -a
# shellcheck disable=SC1090
source "$AI_E2E_ENV"
set +a
# Only crewflow-test-db (15436) — never rab-devdb (15432) or any other host/port.
case "$TEST_DATABASE_URL" in *@127.0.0.1:15436/*) ;; *) echo "refusing: TEST_DATABASE_URL is not crewflow-test-db (127.0.0.1:15436)"; exit 2 ;; esac
case "$TEST_DATABASE_URL" in *:15432/*|*@localhost:15432*) echo "refusing: 15432 is rab-devdb"; exit 2 ;; esac
# Only the shared disposable test Redis (16391) or an AI-build agent's own container (16392-16399).
REDIS_HOSTPORT="$(printf '%s' "$REDIS_URL" | sed -E 's#^redis://([^/@]*@)?(127\.0\.0\.1:[0-9]+).*$#\2#')"
case "$REDIS_HOSTPORT" in 127.0.0.1:1639[1-9]) ;; *) echo "refusing: REDIS_URL is not a disposable test Redis (127.0.0.1:16391-16399)"; exit 2 ;; esac
REDIS_E2E="redis://${REDIS_HOSTPORT}/9"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  # Windows: also end the node children by their command line (the bash job may be a wrapper).
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { \$_.CommandLine -match 'ai-e2e-stack' -or \$_.CommandLine -match '--port ${WEB_PORT} --strictPort' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Runtime env shared by API and Worker. No .env is read: both run with cwd = the scratch dir.
export NODE_ENV=test
export AI_E2E_MARK=ai-e2e-stack
# Phase B: one PG_DATABASE_URL (the restricted runtime login); the deprecated names never reach the API or the Worker.
export PG_DATABASE_URL="$TEST_DATABASE_URL"
unset DATABASE_URL DATABASE_URL_UNPOOLED DATABASE_DIRECT_URL || true
# Security review L-4: command / bootstrap authority never reaches the API or the Worker (their runtime guard refuses it;
# never-in-runtime-env.ts). A caller's env file may carry it for the harness; drop it here.
unset DB_TARGET ALLOW_PRODUCTION_DB_COMMANDS CREWFLOW_BOOTSTRAP_PASSWORD CREWFLOW_APP_BOOTSTRAP_PASSWORD CREWFLOW_MIGRATOR_PASSWORD || true
export REDIS_URL="$REDIS_E2E"
export PORT="$API_PORT" APP_URL="$WEB" CORS_ORIGINS="$WEB"
export EMAIL_DRIVER=LOGGER EMAIL_DELIVERY_ENABLED=false STORAGE_DRIVER=LOCAL STORAGE_LOCAL_ROOT="$AI_E2E_WORK/storage"
export AI_ENABLED=true AI_RETENTION_MODE=off
# The retired names must not leak in from the caller's environment (present-but-empty = unset for validation).
export AI_PROVIDER= AI_MODEL= AI_PROVIDER_API_KEY=
export SENTRY_DSN=

echo "[ai-e2e] seeding synthetic organisations"
(cd "$ROOT" && env -u PG_DATABASE_URL DATABASE_URL_UNPOOLED= E2E_IDENTITIES_OUT="$AI_E2E_WORK/identities.json" \
  node node_modules/ts-node/dist/bin.js --transpile-only -P packages/rab-server/tsconfig.spec.json packages/rab-e2e-testing/ai/seed-ai-e2e.ts) \
  > "$AI_E2E_WORK/seed.log" 2>&1 || { tail -40 "$AI_E2E_WORK/seed.log"; exit 1; }
grep '\[ai-e2e-seed\]' "$AI_E2E_WORK/seed.log"

# Both from SOURCE with ts-node --transpile-only (never tsx: decorator metadata), NODE_ENV=test, test model seams on.
TS_NODE=("node" "$ROOT/node_modules/ts-node/dist/bin.js" "--transpile-only" "-P" "$ROOT/packages/rab-server/tsconfig.spec.json")
echo "[ai-e2e] starting API on :$API_PORT (test-only boot from source)"
(cd "$AI_E2E_WORK" && exec "${TS_NODE[@]}" "$ROOT/packages/rab-e2e-testing/ai/boot-api.e2e.ts" ai-e2e-stack) > "$AI_E2E_WORK/api.log" 2>&1 &
PIDS+=($!)
echo "[ai-e2e] starting the rab-ai consumer (test-only boot from source)"
(cd "$AI_E2E_WORK" && exec "${TS_NODE[@]}" "$ROOT/packages/rab-e2e-testing/ai/boot-worker.e2e.ts" ai-e2e-stack) > "$AI_E2E_WORK/worker.log" 2>&1 &
PIDS+=($!)
echo "[ai-e2e] starting Vite on :$WEB_PORT"
(cd "$ROOT/packages/rab-front" && VITE_API_URL="$API" exec node "$ROOT/node_modules/vite/bin/vite.js" --port "$WEB_PORT" --strictPort --host localhost) > "$AI_E2E_WORK/vite.log" 2>&1 &
PIDS+=($!)

wait_for() {
  local url="$1" name="$2" tries=0
  until curl -s -o /dev/null "$url"; do
    tries=$((tries + 1)); [ "$tries" -gt 120 ] && { echo "[ai-e2e] $name did not start"; tail -40 "$AI_E2E_WORK/$name.log"; exit 1; }
    sleep 1
  done
}
wait_for "http://localhost:${API_PORT}/healthz" api
wait_for "$WEB/login" vite
until grep -q "rab-ai consumer ready" "$AI_E2E_WORK/worker.log" 2>/dev/null; do
  sleep 1; tries=$((${tries:-0} + 1)); [ "$tries" -gt 120 ] && { echo "[ai-e2e] worker did not start"; tail -40 "$AI_E2E_WORK/worker.log"; exit 1; }
done
echo "[ai-e2e] stack up"

if [ "${1:-}" = "--hold" ]; then
  echo "[ai-e2e] holding the stack (identities: $AI_E2E_WORK/identities.json); stop with Ctrl+C"
  wait
  exit 0
fi

cd "$ROOT"
AI_E2E_WEB="$WEB" AI_E2E_API="$API" AI_E2E_IDENTITIES="$AI_E2E_WORK/identities.json" AI_E2E_EVIDENCE="$AI_E2E_WORK/evidence.json" \
  node node_modules/@playwright/test/cli.js test -c packages/rab-e2e-testing/ai/playwright.ai.config.ts "$@"
