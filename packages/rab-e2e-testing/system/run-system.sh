#!/usr/bin/env bash
# Wave 6 lane E2E — the whole system run on a DISPOSABLE stack, end to end.
#
#   E2E_ENV_FILE=<operator env file, outside the repo> E2E_OUT=<output dir, outside the repo> [E2E_MODE=parity|devlike] \
#     bash packages/rab-e2e-testing/system/run-system.sh [up|console|functional|perf|idle <label> <seconds>|down|all]
#
# The database lifecycle is production's (Phase X P0-H; docker-compose.e2e.yml header): a fresh cluster whose only init is
# pg_stat_statements plus the committed 01-crewflow-owner.sql, ONE crewflow_owner login for every process, the server
# migrates on start and registers the BullMQ schedulers, the worker only consumes them, bootstrap-admin runs after the
# server is healthy. E2E_POSTGRES_IMAGE picks the PostgreSQL major (default postgres:16-alpine; postgres:18-alpine works).
#
# `idle <label> <seconds>` is a measurement window on a running stack (no HTTP from this script): it resets
# pg_stat_statements, waits, and writes $E2E_OUT/idle-<label>/ (pgss.tsv every role, summary.txt with the application's
# statement counts per minute and their families from ../cost/lib/sql-families.js). crewflow_owner is the only application
# login, so every non-superuser row came from its sessions (statements run after SET ROLE, such as the in-process
# provisioner's as `crewflow`, are recorded under that role: topLevelByRole shows the split). Idle application SQL is the
# Worker's scans plus the server's own health-check ping (one `SELECT 1` per Docker health probe); the family table names
# both, so the Worker-scan share is read off directly.
#
# E2E_MODE (see lib/env.ts):
#   parity  (default) production's committed runtime flags: HWS OFF, one console host (no workspace host routing, origin
#           trust or login handoff), AI off. Compose project `crewflow-parity`, docker-compose.e2e.yml +
#           docker-compose.parity.yml; API 3400, console 5400, Postgres 15480, Redis 16480.
#   devlike the dev stack's flags: HWS ON, *.localhost workspace hosts, login handoff. Project `crewflow-e2e`; API 3300,
#           console 5300, Postgres 15470, Redis 16470. `perf` runs only here.
# Each mode has its own containers, network and volumes, so both can exist side by side.
#
# `console` runs the host Vite for the mode in the foreground (the specs need it; so does a person trying the stack).
#
# Never touches the dev stack (project `rab`, ports 3000/5173/15432), crewflow-test-db (15436) or any remote database:
# every docker call names this mode's project, and the specs refuse other ports. Teardown (`down`) removes ONLY this
# project's containers, network and volumes.
set -euo pipefail
# Git Bash: hand Windows-native tools (node, docker) mixed-style paths (C:/...), never /c/... ones.
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
ROOT="$(win "$(cd "$(dirname "$0")/../../.." && pwd)")"
SYS="$ROOT/packages/rab-e2e-testing/system"
: "${E2E_ENV_FILE:?set E2E_ENV_FILE}"
: "${E2E_OUT:?set E2E_OUT}"
E2E_ENV_FILE="$(win "$E2E_ENV_FILE")"; E2E_OUT="$(win "$E2E_OUT")"; export E2E_ENV_FILE E2E_OUT
export E2E_MODE="${E2E_MODE:-parity}"
case "$E2E_MODE" in
  # parity ports and project can be overridden to run a second parity stack beside an existing one (same compose files).
  parity) PROJECT=${E2E_COMPOSE_PROJECT:-crewflow-parity}; PG_PORT=${E2E_PG_PORT:-15480}; API_PORT=${E2E_API_PORT:-3400}; FRONT_PORT=${E2E_FRONT_PORT:-5400}; FILES=(-f "$SYS/docker-compose.e2e.yml" -f "$SYS/docker-compose.parity.yml") ;;
  devlike) PROJECT=crewflow-e2e; PG_PORT=15470; API_PORT=3300; FRONT_PORT=5300; FILES=(-f "$SYS/docker-compose.e2e.yml") ;;
  *) echo "E2E_MODE must be parity or devlike (got $E2E_MODE)"; exit 64 ;;
esac
mkdir -p "$E2E_OUT/logs" "$E2E_OUT/perf"
export E2E_STATE_FILE="${E2E_STATE_FILE:-$E2E_OUT/state.json}"
export E2E_RUN_ID="${E2E_RUN_ID:-w6}"
C=(docker compose -p "$PROJECT" --env-file "$E2E_ENV_FILE" "${FILES[@]}")
set -a; . "$E2E_ENV_FILE"; set +a
step() { echo "[$(date -u +%H:%M:%S)] [$E2E_MODE] $*" | tee -a "$E2E_OUT/logs/steps.log"; }
wait_healthy() { # service [timeout_s, default 180]
  local n=$(( ${2:-180} / 2 ))
  for _ in $(seq 1 "$n"); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-$1-1" 2>/dev/null)" = healthy ] && return 0; sleep 2; done
  echo "$PROJECT-$1-1 not healthy after ${2:-180}s" >&2; return 1
}
# Superuser psql INSIDE this project's postgres container (local socket): evidence and pg_stat_statements only, never an
# app login and never another cluster.
q() { docker exec -i "$PROJECT-postgres-1" psql -X -v ON_ERROR_STOP=1 -U rab -d rab_e2e -Atq "$@"; }
redact() { sed -E 's#(postgres(ql)?|redis)://[^ "]+#<url>#g'; }

up() {
  [ "${#E2E_CREWFLOW_OWNER_PASSWORD}" -ge 24 ] || { echo "E2E_CREWFLOW_OWNER_PASSWORD must be at least 24 characters (01-crewflow-owner.sql refuses shorter)"; exit 64; }
  step "up: postgres (${E2E_POSTGRES_IMAGE:-postgres:16-alpine}) + redis; init = pg_stat_statements + 01-crewflow-owner.sql"
  "${C[@]}" up -d postgres redis >/dev/null 2>&1; wait_healthy postgres; wait_healthy redis
  step "postgres: $(q -c 'show server_version') ; logins: $(q -c "select string_agg(rolname, ',' order by rolname) from pg_roles where rolcanlogin")"
  step "up: server (api-prestart.sh: migrates on start, registers the BullMQ schedulers) then worker (consume-only)"
  local t0=$SECONDS
  # compose starts the worker only once the server is healthy (depends_on service_healthy), so this returns after both.
  "${C[@]}" up -d server worker >/dev/null 2>&1 || { docker logs "$PROJECT-server-1" 2>&1 | redact | tail -40; exit 1; }
  wait_healthy server 600; wait_healthy worker 300
  docker logs "$PROJECT-server-1" 2>&1 | redact >"$E2E_OUT/logs/server-start.log"
  step "server + worker healthy in $((SECONDS - t0)) s; migrations: $(q -c 'select count(*) from core.migrations'); schedulers: $(grep -ciE 'register-schedulers|job scheduler' "$E2E_OUT/logs/server-start.log") log line(s)"
  step "bootstrap-admin as crewflow_owner (one-off, after the server is healthy)"
  BOOTSTRAP_ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-w6.admin@crewflow-e2e.test}" BOOTSTRAP_ADMIN_FIRST_NAME=Wave BOOTSTRAP_ADMIN_LAST_NAME=Admin \
    "${C[@]}" --profile ops run --rm --no-deps bootstrap 2>&1 | redact >"$E2E_OUT/logs/bootstrap.log"
  step "stack healthy; HWS_RUNTIME_ENABLED=$(docker exec "$PROJECT-server-1" printenv HWS_RUNTIME_ENABLED); app sessions by login: $(q -c "select string_agg(usename || '=' || n, ',') from (select usename, count(*) n from pg_stat_activity where datname = 'rab_e2e' and usename <> 'rab' group by 1 order by 1) x")"
}

idle() {
  local label="${1:?usage: idle <label> <seconds>}" secs="${2:?usage: idle <label> <seconds>}" R
  R="$E2E_OUT/idle-$label"; mkdir -p "$R"
  step "idle $label: ${secs}s window, pg_stat_statements reset (no HTTP from this script)"
  sleep 3
  q -c 'select pg_stat_statements_reset()' >/dev/null
  date -u +%s >"$R/t-start"; sleep "$secs"; date -u +%s >"$R/t-end"
  # Every role (the harness's own `rab` rows included, so nothing is hidden); the summary leaves out only `rab`.
  q -F $'\t' -c "select r.rolname, s.toplevel, s.calls, s.rows, round(s.total_exec_time::numeric, 3), regexp_replace(left(s.query, 400), E'[\\n\\r\\t ]+', ' ', 'g') from pg_stat_statements s join pg_roles r on r.oid = s.userid join pg_database d on d.oid = s.dbid where d.datname = 'rab_e2e' order by s.calls desc" >"$R/pgss.tsv"
  node "$ROOT/packages/rab-e2e-testing/cost/lib/sql-families.js" "$R/pgss.tsv" "$(( $(cat "$R/t-end") - $(cat "$R/t-start") ))" | tee "$R/summary.txt"
}

console() {
  step "console: host Vite on 127.0.0.1:$FRONT_PORT → API 127.0.0.1:$API_PORT (foreground)"
  cd "$ROOT" && MSYS_NO_PATHCONV=1 VITE_API_URL=/rest/v1 VITE_API_PROXY_TARGET="http://127.0.0.1:$API_PORT" \
    exec node node_modules/vite/bin/vite.js --config packages/rab-e2e-testing/system/vite.e2e.config.ts
}

pw() { node "$ROOT/node_modules/@playwright/test/cli.js" test -c "$SYS/playwright.system.config.ts" "$@"; }

functional() {
  step "functional specs 01-05 + 08 + 09"
  E2E_JSON_REPORT="$E2E_OUT/functional-report.json" pw specs/01 specs/02 specs/03 specs/04 specs/05 specs/08 specs/09 2>&1 | tee "$E2E_OUT/logs/functional.log" | grep -E '^\s+(ok|x|-) |passed|failed|skipped' || true
}

perf() {
  [ "$E2E_MODE" = devlike ] || { echo "perf runs in E2E_MODE=devlike only (its scripts address the devlike ports)"; exit 64; }
  step "perf: seed"
  node "$SYS/perf/seed.mjs" "$E2E_STATE_FILE" "$E2E_ENV_FILE" 2000 1700 4 | tee "$E2E_OUT/perf/seed.log"
  step "perf: payroll run over the seeded period + loaded workspace creation"
  E2E_JSON_REPORT="$E2E_OUT/perf-setup-report.json" pw specs/06 2>&1 | tee "$E2E_OUT/logs/perf-setup.log" | grep -E '^\s+(ok|x) |passed|failed' || true
  sleep 20
  step "perf: light (dev-like, sequential, per-IP throttles apply)"
  node "$SYS/perf/load.mjs" "$E2E_STATE_FILE" "$E2E_OUT/perf/light.json" light 1 60 | tee "$E2E_OUT/perf/light.txt"
  step "perf: recreate server with TRUSTED_PROXY_CIDRS (Docker gateway) for distinct client IPs"
  local gw; gw=$(docker network inspect "${PROJECT}_default" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
  E2E_GOOGLE_ENABLED=true E2E_TRUSTED_PROXY_CIDRS="$gw/32,192.168.65.0/24" "${C[@]}" up -d --no-deps --force-recreate server >/dev/null 2>&1; sleep 5; wait_healthy server
  date -u +%FT%TZ >"$E2E_OUT/perf/load.since"
  step "perf: load, 8 concurrent virtual users"
  node "$SYS/perf/load.mjs" "$E2E_STATE_FILE" "$E2E_OUT/perf/load-c8.json" load 8 300 | tee "$E2E_OUT/perf/load-c8.txt"
  docker logs --since "$(cat "$E2E_OUT/perf/load.since")" "$PROJECT-server-1" >"$E2E_OUT/perf/server-during-load.log" 2>&1 || true
  docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}' "$PROJECT-server-1" "$PROJECT-worker-1" "$PROJECT-postgres-1" "$PROJECT-redis-1" | tee "$E2E_OUT/perf/docker-stats-after.txt"
}

down() {
  step "down: $PROJECT only (containers, network, volumes)"
  "${C[@]}" --profile ops down -v
}

case "${1:-all}" in
  up) up ;;
  idle) shift; idle "$@" ;;
  console) console ;;
  functional) functional ;;
  perf) perf ;;
  down) down ;;
  all) up; functional; [ "$E2E_MODE" = devlike ] && perf || true ;;
  *) echo "usage: $0 [up|console|functional|perf|idle <label> <seconds>|down|all]"; exit 64 ;;
esac
