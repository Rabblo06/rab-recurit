#!/usr/bin/env bash
# Live-backend web E2E: the specs in playwright.live.config.ts against a REAL API, PostgreSQL and Redis — disposable ones only.
#
#   E2E_LIVE_WORK=<scratch dir> bash packages/rab-e2e-testing/live/run-live.sh [spec name ...]
#
# Needs in the environment (CI: .github/actions/disposable-postgres + the M2 harness fresh install +
# migration-security-test-env.cjs; locally: the same harness on crewflow-test-db 127.0.0.1:15436):
#   TEST_DATABASE_URL           crewflow_app (restricted runtime role, NOBYPASSRLS) — the ONLY URL the API processes get
#   TEST_DATABASE_URL_UNPOOLED  the disposable cluster's bootstrap superuser — the seed's fixture connection only
#   REDIS_URL                   a disposable Redis (CI: a service container; locally crewflow-test-redis 127.0.0.1:16391)
#   APP_SECRET                  random per run
#   E2E_DB_CONTAINER / E2E_DB_USER / E2E_DB_NAME  where devices-sessions-live reads session counts (docker exec psql, read-only)
# and the API built (`npx nx build rab-server`; the API runs from dist, exactly as deployed) plus @rab/shared and @rab/ui built.
#
# Two stacks, one after the other, because the specs pin two pairs of origins (overridable for local runs, CI uses the defaults):
#   console  API :3000 (E2E_API_PORT)    + Vite :5173 (E2E_WEB_PORT)    — smoke, qa_shift_workflow, table-toolbar-*, session-race, cookie-race, performance-baseline
#   qa       API :3999 (E2E_QA_API_PORT) + Vite :5174 (E2E_QA_WEB_PORT) — devices-sessions-live, ui-corrections-live
# Each stack uses its own Redis logical database, so the two never share rate-limit buckets.
#
# Rate limits are REAL (login/refresh 5 per minute per IP, the per-(email, IP) login limiter) and are never relaxed here.
# Every spec paces its own calls; before each spec file the runner waits out the throttle window (E2E_LIVE_COOLDOWN_SECONDS,
# default 65) so the warm-up's or the previous file's calls never count against the next file's budget.
#
# Exits non-zero when any spec fails or any piece of the stack does not start. Prints no secret.
set -uo pipefail
# The whole script is one function, parsed before it runs: editing this file during a run cannot change that run.
main() {

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$E2E_DIR/../.." && pwd)"
win() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

: "${E2E_LIVE_WORK:?set E2E_LIVE_WORK to a scratch directory (logs, seeded identities)}"
for v in TEST_DATABASE_URL TEST_DATABASE_URL_UNPOOLED REDIS_URL APP_SECRET; do
  [ -n "${!v:-}" ] || { echo "[e2e-live] $v is required"; exit 2; }
done
mkdir -p "$E2E_LIVE_WORK"
WORK="$(win "$(cd "$E2E_LIVE_WORK" && pwd)")"

export E2E_API_PORT="${E2E_API_PORT:-3000}" E2E_WEB_PORT="${E2E_WEB_PORT:-5173}"
export E2E_QA_API_PORT="${E2E_QA_API_PORT:-3999}" E2E_QA_WEB_PORT="${E2E_QA_WEB_PORT:-5174}"
export E2E_API_ORIGIN="http://127.0.0.1:${E2E_API_PORT}" E2E_WEB_ORIGIN="http://127.0.0.1:${E2E_WEB_PORT}"
export E2E_QA_API_ORIGIN="http://127.0.0.1:${E2E_QA_API_PORT}" E2E_QA_WEB_ORIGIN="http://127.0.0.1:${E2E_QA_WEB_PORT}"
COOLDOWN="${E2E_LIVE_COOLDOWN_SECONDS:-65}"

# Loopback databases and Redis only: never a remote host.
for v in TEST_DATABASE_URL TEST_DATABASE_URL_UNPOOLED REDIS_URL; do
  host="$(node -e 'try{process.stdout.write(new URL(process.env[process.argv[1]]).hostname)}catch{process.stdout.write("?")}' "$v")"
  case "$host" in 127.0.0.1|localhost) ;; *) echo "[e2e-live] refusing: $v is not a loopback host"; exit 2 ;; esac
done
# Logical databases E2E_LIVE_REDIS_DB_OFFSET+1..+3 (offset default 0: CI's own service container; locally pick a free range).
redis_db() { node -e 'const u=new URL(process.env.REDIS_URL);u.pathname="/"+(Number(process.env.E2E_LIVE_REDIS_DB_OFFSET||0)+Number(process.argv[1]));process.stdout.write(u.toString())' "$1"; }

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    if [ -r "/proc/$pid/winpid" ]; then taskkill //F //T //PID "$(cat "/proc/$pid/winpid")" > /dev/null 2>&1 || true; fi
    kill "$pid" > /dev/null 2>&1 || true
  done
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

port_free() { ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/"; }
for p in "$E2E_API_PORT" "$E2E_WEB_PORT" "$E2E_QA_API_PORT" "$E2E_QA_WEB_PORT"; do
  port_free "$p" || { echo "[e2e-live] refusing: 127.0.0.1:$p is already in use (never reuse another stack)"; exit 2; }
done
[ -f "$ROOT/packages/rab-server/dist/main.js" ] || { echo "[e2e-live] packages/rab-server/dist/main.js is missing: build the server first"; exit 2; }

if [ "${E2E_LIVE_REUSE_SEED:-}" = 1 ] && [ -f "$WORK/live.env" ]; then
  echo "[e2e-live] reusing the seed already in $WORK (local re-runs only)"
else
  echo "[e2e-live] seeding synthetic organisations"
  (cd "$ROOT" && NODE_ENV=test REDIS_URL="$(redis_db 3)" E2E_LIVE_OUT="$WORK" PG_DATABASE_URL='' DATABASE_URL='' DATABASE_URL_UNPOOLED='' \
    node node_modules/ts-node/dist/bin.js --transpile-only -P packages/rab-server/tsconfig.spec.json packages/rab-e2e-testing/live/seed-live-e2e.ts) \
    > "$WORK/seed.log" 2>&1 || { echo "[e2e-live] seed failed"; tail -40 "$WORK/seed.log"; exit 1; }
  grep '\[e2e-live-seed\]' "$WORK/seed.log"
fi
# shellcheck disable=SC1091
source "$WORK/live.env"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::${E2E_SEED_PASSWORD}"; echo "::add-mask::${E2E_MANAGER_PASSWORD}"; fi
export QA_UI="$WORK/qa-ui.json" QA_IDENTITIES="$WORK/qa-identities.json"

# The API from the BUILT server (dist/main.js), validated at boot like any deployment: development runtime on a loopback
# database, connected as crewflow_app only through PG_DATABASE_URL (Phase B; no deprecated names, no
# DATABASE_URL_UNPOOLED and no DB_TARGET: main.js refuses to start if a privileged URL or command authority is present), email to the log driver, local file storage in the scratch dir. cwd = the scratch dir, so no .env is read.
start_api() { # name port web_origin redis_db
  local name="$1" port="$2" web="$3" db="$4"
  mkdir -p "$WORK/$name-storage"
  (cd "$WORK" && exec env -u DATABASE_URL -u DATABASE_DIRECT_URL -u DATABASE_URL_UNPOOLED -u TEST_DATABASE_URL_UNPOOLED -u TEST_DATABASE_URL -u TEST_DATABASE_CREWFLOW_URL -u CREWFLOW_BOOTSTRAP_PASSWORD -u CREWFLOW_APP_BOOTSTRAP_PASSWORD -u MIGRATION_SECURITY_ADMIN_URL -u DB_TARGET -u ALLOW_PRODUCTION_DB_COMMANDS \
    NODE_ENV=development RAB_RUNTIME_ENV=development \
    PG_DATABASE_URL="$TEST_DATABASE_URL" REDIS_URL="$(redis_db "$db")" APP_SECRET="$APP_SECRET" PORT="$port" \
    APP_URL="$web" ACCOUNTS_URL="$web" CORS_ORIGINS="$web,${web/127.0.0.1/localhost}" \
    EMAIL_DRIVER=LOGGER STORAGE_DRIVER=LOCAL STORAGE_LOCAL_ROOT="$WORK/$name-storage" SENTRY_DSN= \
    node "$(win "$ROOT")/packages/rab-server/dist/main.js") > "$WORK/api-$name.log" 2>&1 &
  PIDS+=($!)
}
start_web() { # name port api_origin
  # Vite gets no database URL, bootstrap password or app secret either: only the public API origin it builds into the page.
  (cd "$ROOT/packages/rab-front" && exec env -u PG_DATABASE_URL -u DATABASE_URL -u DATABASE_URL_UNPOOLED -u TEST_DATABASE_URL -u TEST_DATABASE_URL_UNPOOLED -u TEST_DATABASE_CREWFLOW_URL     -u CREWFLOW_BOOTSTRAP_PASSWORD -u CREWFLOW_APP_BOOTSTRAP_PASSWORD -u MIGRATION_SECURITY_ADMIN_URL -u APP_SECRET     VITE_API_URL="$3/rest/v1" node "$(win "$ROOT")/node_modules/vite/bin/vite.js" --port "$2" --strictPort --host 127.0.0.1) > "$WORK/web-$1.log" 2>&1 &
  PIDS+=($!)
}
wait_for() { # url name
  for _ in $(seq 1 300); do curl -s -o /dev/null --max-time 2 "$1" && return 0; sleep 1; done
  echo "[e2e-live] $2 did not start"; tail -60 "$WORK/$2.log"; exit 1
}

stop_stack() {
  cleanup
  PIDS=()
  for p in "$@"; do for _ in $(seq 1 30); do port_free "$p" && break; sleep 1; done; done
}
run_spec() { # spec
  echo "[e2e-live] waiting ${COOLDOWN}s for the auth throttle window before $1"
  sleep "$COOLDOWN"
  echo "[e2e-live] ---- $1"
  # The Playwright process gets no database URL, bootstrap password or app secret. One spec does read the database:
  # devices-sessions-live counts a QA user's usable sessions with `docker exec <E2E_DB_CONTAINER> psql -U <E2E_DB_USER>`,
  # i.e. through the disposable container's local socket as that cluster's bootstrap SUPERUSER (CI: ci_bootstrap on the
  # throwaway disposable-postgres; locally: rab on crewflow-test-db), because the count must see past RLS. The query is
  # one SELECT inside BEGIN READ ONLY ... ROLLBACK and nothing else uses that access. --workers=1.
  (cd "$E2E_DIR" && unset TEST_DATABASE_URL TEST_DATABASE_URL_UNPOOLED TEST_DATABASE_CREWFLOW_URL CREWFLOW_BOOTSTRAP_PASSWORD CREWFLOW_APP_BOOTSTRAP_PASSWORD MIGRATION_SECURITY_ADMIN_URL APP_SECRET     && E2E_LIVE_HTML_REPORT="$ROOT/test-results/e2e-live/report/$1" E2E_LIVE_OUTPUT_DIR="$ROOT/test-results/e2e-live/results/$1"     node "$ROOT/node_modules/@playwright/test/cli.js" test -c playwright.live.config.ts --workers=1 "web/$1.spec.ts")
}

# performance-baseline is a measurement, gated off for ordinary local runs; the live job runs it (and keeps its JSON).
export RUN_PERF_BASELINE=true
# The spec lists come from live/live-specs.json, the same file playwright.live.config.ts (and so the coverage check) reads.
live_specs() { node -e 'process.stdout.write(require(process.argv[1])[process.argv[2]].join(" "))' "$(win "$HERE")/live-specs.json" "$1"; }
read -r -a CONSOLE_SPECS <<< "$(live_specs console)"
read -r -a QA_SPECS <<< "$(live_specs qa)"
[ "${#CONSOLE_SPECS[@]}" -gt 0 ] && [ "${#QA_SPECS[@]}" -gt 0 ] || { echo "[e2e-live] could not read live/live-specs.json"; exit 2; }
if [ "$#" -gt 0 ]; then # a subset, e.g. `run-live.sh smoke ui-corrections-live`
  want=" $* "; c=(); q=()
  for x in "${CONSOLE_SPECS[@]}"; do [[ "$want" == *" $x "* ]] && c+=("$x"); done
  for x in "${QA_SPECS[@]}"; do [[ "$want" == *" $x "* ]] && q+=("$x"); done
  [ $(( ${#c[@]} + ${#q[@]} )) -eq "$#" ] || { echo "[e2e-live] unknown spec name in: $*"; exit 2; }
  CONSOLE_SPECS=("${c[@]}"); QA_SPECS=("${q[@]}")
fi
failed=()
ran=0
# One stack at a time (memory): console first, then qa. Each stack has its own Redis logical database.
for stack in console qa; do
  if [ "$stack" = console ]; then specs=("${CONSOLE_SPECS[@]}"); api_port="$E2E_API_PORT"; web_port="$E2E_WEB_PORT"; api="$E2E_API_ORIGIN"; web="$E2E_WEB_ORIGIN"; db=1
  else specs=("${QA_SPECS[@]}"); api_port="$E2E_QA_API_PORT"; web_port="$E2E_QA_WEB_PORT"; api="$E2E_QA_API_ORIGIN"; web="$E2E_QA_WEB_ORIGIN"; db=2; fi
  [ "${#specs[@]}" -gt 0 ] || continue
  echo "[e2e-live] starting the $stack stack (API :$api_port, Vite :$web_port)"
  start_api "$stack" "$api_port" "$web" "$db"
  start_web "$stack" "$web_port" "$api"
  wait_for "$api/healthz" "api-$stack"
  wait_for "$web/" "web-$stack"
  grep -h '\[runtime-db-guard\]' "$WORK/api-$stack.log" | sed -E 's/ cluster=[0-9]+//'
  (cd "$E2E_DIR" && node live/warm-up.mjs "$web") || { echo "[e2e-live] the $stack console never rendered its sign-in screen"; tail -40 "$WORK/web-$stack.log"; exit 1; }
  for spec in "${specs[@]}"; do
    ran=$((ran + 1))
    run_spec "$spec" || failed+=("$spec")
  done
  stop_stack "$api_port" "$web_port"
done
if [ "${#failed[@]}" -gt 0 ]; then echo "[e2e-live] FAILED: ${failed[*]}"; exit 1; fi
echo "[e2e-live] all $ran live spec files passed"
}

main "$@"
