#!/usr/bin/env bash
# AI Phase 1 full-flow E2E on a disposable stack this script starts and stops itself:
#   rab-server (compiled dist) on :3998, rab-worker (ts-node, from source), Vite on :5176,
#   against crewflow-test-db (127.0.0.1:15436) and crewflow-test-redis (127.0.0.1:16391, Redis db index 9),
#   AI_ENABLED=true with the deterministic mock provider. Synthetic organisations only.
# Never the owner's docker `rab` stack, rab-devdb, Neon or production.
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
case "$TEST_DATABASE_URL" in *@127.0.0.1:15436/*) ;; *) echo "refusing: TEST_DATABASE_URL is not crewflow-test-db (127.0.0.1:15436)"; exit 2 ;; esac
case "$REDIS_URL" in redis://127.0.0.1:16391*) ;; *) echo "refusing: REDIS_URL is not crewflow-test-redis (127.0.0.1:16391)"; exit 2 ;; esac
REDIS_E2E="redis://127.0.0.1:16391/9"

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
export DATABASE_URL="$TEST_DATABASE_URL"
unset DATABASE_URL_UNPOOLED || true
export REDIS_URL="$REDIS_E2E"
export PORT="$API_PORT" APP_URL="$WEB" CORS_ORIGINS="$WEB"
export EMAIL_DRIVER=LOGGER EMAIL_DELIVERY_ENABLED=false STORAGE_DRIVER=LOCAL STORAGE_LOCAL_ROOT="$AI_E2E_WORK/storage"
export AI_ENABLED=true AI_PROVIDER=mock AI_MODEL=crewflow-mock-1 AI_RETENTION_MODE=off
export SENTRY_DSN=

echo "[ai-e2e] building rab-server dist (the Worker imports it)"
(cd "$ROOT" && node node_modules/typescript/bin/tsc -p packages/rab-server/tsconfig.app.json)

echo "[ai-e2e] seeding synthetic organisations"
(cd "$ROOT" && DATABASE_URL_UNPOOLED= E2E_IDENTITIES_OUT="$AI_E2E_WORK/identities.json" \
  node node_modules/ts-node/dist/bin.js --transpile-only -P packages/rab-server/tsconfig.spec.json packages/rab-e2e-testing/ai/seed-ai-e2e.ts) \
  > "$AI_E2E_WORK/seed.log" 2>&1 || { tail -40 "$AI_E2E_WORK/seed.log"; exit 1; }
grep '\[ai-e2e-seed\]' "$AI_E2E_WORK/seed.log"

echo "[ai-e2e] starting API on :$API_PORT"
(cd "$AI_E2E_WORK" && exec node "$ROOT/packages/rab-server/dist/main.js" ai-e2e-stack) > "$AI_E2E_WORK/api.log" 2>&1 &
PIDS+=($!)
echo "[ai-e2e] starting Worker"
(cd "$AI_E2E_WORK" && exec node "$ROOT/node_modules/ts-node/dist/bin.js" --transpile-only -P "$ROOT/packages/rab-worker/tsconfig.app.json" "$ROOT/packages/rab-worker/src/main.ts" ai-e2e-stack) > "$AI_E2E_WORK/worker.log" 2>&1 &
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
until grep -q "rab-ai" "$AI_E2E_WORK/worker.log" 2>/dev/null || grep -qi "worker.*ready\|consumers started\|listening" "$AI_E2E_WORK/worker.log" 2>/dev/null; do
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
