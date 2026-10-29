#!/usr/bin/env bash
# Runs every AI visual / a11y suite under web/ai with its own config, against a rab-front Vite dev server of THIS
# checkout started on the suite's documented port. All API traffic is answered in the browser by the fictional rab-docs
# fixtures (packages/rab-docs/tools/web/*.cjs), whose origin is set to the same Vite origin; nothing reaches a backend.
#
#   bash packages/rab-e2e-testing/web/ai/run-ai-visual.sh                 # every suite
#   AI_SUITES="u1 u8" bash packages/rab-e2e-testing/web/ai/run-ai-visual.sh  # a subset
#   bash packages/rab-e2e-testing/web/ai/run-ai-visual.sh --update-snapshots # extra args go to `playwright test`
#
# Needs @rab/shared and @rab/ui built (`npx nx run-many -t build -p rab-shared,rab-ui`) and, on Linux, the Playwright
# Chromium (`yarn playwright install --with-deps chromium` in packages/rab-e2e-testing). On Windows / macOS the configs
# use the installed Google Chrome (`channel: 'chrome'`), which is what the original baselines were captured with.
# Baselines per OS: Windows in __screenshots__/<suite>/, Linux in __screenshots__/<suite>/linux/ (generated in
# mcr.microsoft.com/playwright:v1.64.1-noble from the same code, after the Windows set passed unchanged). Failure
# artefacts (actual / expected / diff) land in packages/rab-e2e-testing/test-results/ai-<suite>/.
# Ports: 5198 for u1 / u2 / u3 / u5 / u8, 5199 for u-settings (never the dev stack's 3000 / 5173 / 5174).
# Exits non-zero if any suite fails, or if a Vite server does not come up.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$E2E_DIR/../.." && pwd)"
FRONT="$REPO/packages/rab-front"
VITE_BIN="$(cd "$REPO" && node -p "require('path').join(require('path').dirname(require.resolve('vite/package.json', { paths: ['packages/rab-front'] })), 'bin', 'vite.js')")"
# Vite logs live outside test-results/, which Playwright empties at the start of every run.
LOG_DIR="${AI_VISUAL_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"

SUITES="${AI_SUITES:-u1 u2 u3 u5 u8 u-settings}"
port_for() { if [ "$1" = "u-settings" ]; then echo 5199; else echo 5198; fi; }
env_for() { if [ "$1" = "u-settings" ]; then echo U_SETTINGS_WEB; else echo "$(echo "$1" | tr '[:lower:]' '[:upper:]')_WEB"; fi; }

VITE_PID=""
VITE_PORT=""

stop_vite() {
  [ -n "$VITE_PID" ] || return 0
  if [ -r "/proc/$VITE_PID/winpid" ]; then
    # Git Bash: kill the native node.exe (and its esbuild child) by its Windows pid.
    taskkill //F //T //PID "$(cat "/proc/$VITE_PID/winpid")" >/dev/null 2>&1 || true
  fi
  kill "$VITE_PID" >/dev/null 2>&1 || true
  wait "$VITE_PID" 2>/dev/null || true
  VITE_PID=""
  VITE_PORT=""
}
trap stop_vite EXIT
trap 'stop_vite; exit 130' INT TERM

start_vite() {
  local port="$1"
  [ "$VITE_PORT" = "$port" ] && return 0
  stop_vite
  if curl -s -o /dev/null --max-time 2 "http://localhost:$port/"; then
    echo "[ai-visual] port $port is already in use; refusing to test against a server that is not this checkout's" >&2
    return 1
  fi
  echo "[ai-visual] starting rab-front Vite on http://localhost:$port (log: $LOG_DIR/vite-$port.log)"
  (cd "$FRONT" && exec node "$VITE_BIN" --port "$port" --strictPort --host localhost) >"$LOG_DIR/vite-$port.log" 2>&1 &
  VITE_PID=$!
  local i
  for i in $(seq 1 120); do
    if curl -s -o /dev/null --max-time 2 "http://localhost:$port/"; then
      # Request the entry once so Vite transforms it and pre-bundles dependencies before the first test page loads.
      curl -s -o /dev/null --max-time 60 "http://localhost:$port/src/main.tsx" || true
      VITE_PORT="$port"
      return 0
    fi
    if ! kill -0 "$VITE_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  echo "[ai-visual] Vite did not become ready on port $port" >&2
  cat "$LOG_DIR/vite-$port.log" >&2 || true
  stop_vite
  return 1
}

failed=()
passed=()
for suite in $SUITES; do
  config="$HERE/playwright.$suite.config.ts"
  if [ ! -f "$config" ]; then
    echo "[ai-visual] unknown suite '$suite' (no $config)" >&2
    failed+=("$suite")
    continue
  fi
  port="$(port_for "$suite")"
  origin="http://localhost:$port"
  if ! start_vite "$port"; then
    failed+=("$suite")
    continue
  fi
  echo "[ai-visual] === $suite ($origin)"
  if (cd "$E2E_DIR" && env CREWFLOW_WEB_ORIGIN="$origin" "$(env_for "$suite")=$origin" \
    yarn playwright test -c "web/ai/playwright.$suite.config.ts" "$@"); then
    passed+=("$suite")
  else
    failed+=("$suite")
  fi
done

stop_vite
echo "[ai-visual] passed: ${passed[*]:-none}"
if [ "${#failed[@]}" -gt 0 ]; then
  echo "[ai-visual] FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "[ai-visual] all suites passed"
