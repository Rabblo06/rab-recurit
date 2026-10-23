#!/usr/bin/env bash
# Wave 6 lane E2E — the whole system run on a DISPOSABLE stack (compose project `crewflow-e2e`), end to end.
#
#   E2E_ENV_FILE=<operator env file, outside the repo> E2E_OUT=<output dir, outside the repo> \
#     bash packages/rab-e2e-testing/system/run-system.sh [up|functional|perf|down|all]
#
# Never touches the dev stack (project `rab`, ports 3000/5173/15432), crewflow-test-db (15436) or any remote database:
# every docker call names project `crewflow-e2e`, and the specs refuse other ports. Teardown (`down`) removes ONLY this
# project's containers, network and volumes.
set -euo pipefail
# Git Bash: hand Windows-native tools (node, docker) mixed-style paths (C:/...), never /c/... ones.
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
ROOT="$(win "$(cd "$(dirname "$0")/../../.." && pwd)")"
COMPOSE_FILE="$ROOT/packages/rab-e2e-testing/system/docker-compose.e2e.yml"
: "${E2E_ENV_FILE:?set E2E_ENV_FILE}"
: "${E2E_OUT:?set E2E_OUT}"
E2E_ENV_FILE="$(win "$E2E_ENV_FILE")"; E2E_OUT="$(win "$E2E_OUT")"; export E2E_ENV_FILE E2E_OUT
mkdir -p "$E2E_OUT/logs" "$E2E_OUT/perf"
export E2E_STATE_FILE="${E2E_STATE_FILE:-$E2E_OUT/state.json}"
export E2E_RUN_ID="${E2E_RUN_ID:-w6}"
C=(docker compose -p crewflow-e2e --env-file "$E2E_ENV_FILE" -f "$COMPOSE_FILE")
set -a; . "$E2E_ENV_FILE"; set +a
step() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$E2E_OUT/logs/steps.log"; }
wait_healthy() { for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' "crewflow-e2e-$1-1" 2>/dev/null)" = healthy ] && return 0; sleep 2; done; return 1; }

up() {
  step "up: postgres + redis"
  "${C[@]}" up -d postgres redis >/dev/null 2>&1; wait_healthy postgres; wait_healthy redis
  step "migrate phase A as rab_owner (expected to stop at the role split)"
  local t0=$SECONDS
  CREWFLOW_MIGRATION_PHASE=A CREWFLOW_MIGRATION_DATABASE_URL="postgres://rab_owner:rab_owner_dev_only@postgres:5432/rab_e2e" \
    "${C[@]}" --profile ops run --rm migrate >"$E2E_OUT/logs/migrate-A.log" 2>&1 || true
  step "phase A done in $((SECONDS - t0)) s: $(grep -c 'refuses to run as' "$E2E_OUT/logs/migrate-A.log") role-split refusal(s)"
  t0=$SECONDS
  CREWFLOW_MIGRATION_PHASE=B CREWFLOW_MIGRATION_DATABASE_URL="postgres://rab:${E2E_PG_SUPERUSER_PASSWORD}@postgres:5432/rab_e2e" \
    "${C[@]}" --profile ops run --rm migrate 2>&1 | sed "s/${E2E_PG_SUPERUSER_PASSWORD}/***/g" >"$E2E_OUT/logs/migrate-B.log"
  step "phase B (superuser) done in $((SECONDS - t0)) s; migrations: $(PGPASSWORD=$E2E_PG_SUPERUSER_PASSWORD psql -h 127.0.0.1 -p 15470 -U rab -d rab_e2e -tAc 'select count(*) from core.migrations')"
  step "bootstrap-admin as crewflow"
  BOOTSTRAP_ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-w6.admin@crewflow-e2e.test}" BOOTSTRAP_ADMIN_FIRST_NAME=Wave BOOTSTRAP_ADMIN_LAST_NAME=Admin \
    "${C[@]}" --profile ops run --rm bootstrap >"$E2E_OUT/logs/bootstrap.log" 2>&1
  step "up: server + worker"
  "${C[@]}" up -d server worker >/dev/null 2>&1; wait_healthy server; wait_healthy worker
  step "stack healthy"
}

pw() { node "$ROOT/node_modules/@playwright/test/cli.js" test -c "$ROOT/packages/rab-e2e-testing/system/playwright.system.config.ts" "$@"; }

functional() {
  step "functional specs 01-05 + 07"
  E2E_JSON_REPORT="$E2E_OUT/functional-report.json" pw specs/01 specs/02 specs/03 specs/04 specs/05 specs/07 2>&1 | tee "$E2E_OUT/logs/functional.log" | grep -E '^\s+(ok|x|-) |passed|failed|skipped' || true
}

perf() {
  step "perf: seed"
  node "$ROOT/packages/rab-e2e-testing/system/perf/seed.mjs" "$E2E_STATE_FILE" "$E2E_ENV_FILE" 2000 1700 4 | tee "$E2E_OUT/perf/seed.log"
  step "perf: payroll run over the seeded period + loaded workspace creation"
  E2E_JSON_REPORT="$E2E_OUT/perf-setup-report.json" pw specs/06 2>&1 | tee "$E2E_OUT/logs/perf-setup.log" | grep -E '^\s+(ok|x) |passed|failed' || true
  sleep 20
  step "perf: light (dev-like, sequential, per-IP throttles apply)"
  node "$ROOT/packages/rab-e2e-testing/system/perf/load.mjs" "$E2E_STATE_FILE" "$E2E_OUT/perf/light.json" light 1 60 | tee "$E2E_OUT/perf/light.txt"
  step "perf: recreate server with TRUSTED_PROXY_CIDRS (Docker gateway) for distinct client IPs"
  local gw; gw=$(docker network inspect crewflow-e2e_default -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
  E2E_GOOGLE_ENABLED=true E2E_TRUSTED_PROXY_CIDRS="$gw/32,192.168.65.0/24" "${C[@]}" up -d --no-deps --force-recreate server >/dev/null 2>&1; sleep 5; wait_healthy server
  date -u +%FT%TZ >"$E2E_OUT/perf/load.since"
  step "perf: load, 8 concurrent virtual users"
  node "$ROOT/packages/rab-e2e-testing/system/perf/load.mjs" "$E2E_STATE_FILE" "$E2E_OUT/perf/load-c8.json" load 8 300 | tee "$E2E_OUT/perf/load-c8.txt"
  docker logs --since "$(cat "$E2E_OUT/perf/load.since")" crewflow-e2e-server-1 >"$E2E_OUT/perf/server-during-load.log" 2>&1 || true
  docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}' crewflow-e2e-server-1 crewflow-e2e-worker-1 crewflow-e2e-postgres-1 crewflow-e2e-redis-1 | tee "$E2E_OUT/perf/docker-stats-after.txt"
}

down() {
  step "down: crewflow-e2e only (containers, network, volumes)"
  "${C[@]}" --profile ops down -v
}

case "${1:-all}" in
  up) up ;;
  functional) functional ;;
  perf) perf ;;
  down) down ;;
  all) up; functional; perf ;;
  *) echo "usage: $0 [up|functional|perf|down|all]"; exit 64 ;;
esac
