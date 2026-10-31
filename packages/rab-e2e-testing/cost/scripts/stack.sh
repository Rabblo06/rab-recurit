#!/usr/bin/env bash
# Lifecycle of the disposable crewflow-cost stack. Every step is idempotent-or-refusing; none touches anything outside
# the crewflow-cost compose project.
#   COST_TAG=<tag> scripts/stack.sh infra      start pg + redis + minio (+ bucket)
#   COST_TAG=<tag> scripts/stack.sh migrate    phase A as rab_owner (expected to stop at the role split), phase B as the bootstrap superuser
#   COST_TAG=<tag> scripts/stack.sh seed       deterministic 20-org / 1,000-user seed + history backfill (real PDF renderer)
#   COST_TAG=<tag> scripts/stack.sh app        start api + worker and wait for health
#   COST_TAG=<tag> scripts/stack.sh down       remove containers, volumes and network of this project only, after
#                                              assert_project_scope (lib/guard.sh) has verified every resource carrying
#                                              the project label also carries a harness name
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
load_secrets
require_tag
OUT="${OUT:-$COST_WORK/out-$COST_TAG}"; assert_outside_main "the results directory (OUT)" "$OUT"; mkdir -p "$OUT"

assert_disposable() {
  local m; m="$(q "select shobj_description(oid,'pg_database') from pg_database where datname='rab'")"
  [ "$m" = "crewflow-cost disposable measurement database" ] || die "costaudit-pg does not carry the disposable marker; refusing"
}

wait_healthy() { # container timeout_s
  local c="$1" t="${2:-180}" s
  for _ in $(seq 1 "$t"); do
    s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)"
    [ "$s" = healthy ] && return 0
    sleep 1
  done
  die "$c not healthy after ${t}s (last: $s)"
}

case "${1:?usage: stack.sh infra|migrate|seed|app|down}" in
  infra)
    dc up -d pg redis minio
    wait_healthy costaudit-pg; wait_healthy costaudit-redis; wait_healthy costaudit-minio
    dc up minio-init
    assert_disposable
    log "infra up"
    ;;
  migrate)
    assert_disposable
    log "migration phase A (rab_owner; expected to stop at CrewflowSingleCredentialRoleArchitecture1786682000000)"
    set +e
    CREWFLOW_MIGRATION_PHASE=A CREWFLOW_MIGRATION_DATABASE_URL="postgres://rab_owner:${RAB_OWNER_PW}@pg:5432/rab" \
      dc --profile ops run --rm -T migrate > "$OUT/migrate-phaseA.log" 2>&1
    a=$?
    set -e
    sed -E 's#postgres(ql)?://[^ ]+#<url>#g' -i "$OUT/migrate-phaseA.log"
    if [ "$a" -ne 0 ] && ! grep -q "refuses to run as 'rab_owner'" "$OUT/migrate-phaseA.log"; then die "phase A failed unexpectedly (see $OUT/migrate-phaseA.log)"; fi
    log "migration phase B (bootstrap superuser)"
    CREWFLOW_MIGRATION_PHASE=B CREWFLOW_MIGRATION_DATABASE_URL="postgres://rab:${PG_SUPER_PW}@pg:5432/rab" \
      dc --profile ops run --rm -T migrate > "$OUT/migrate-phaseB.log" 2>&1 || { sed -E 's#postgres(ql)?://[^ ]+#<url>#g' -i "$OUT/migrate-phaseB.log"; die "phase B failed (see $OUT/migrate-phaseB.log)"; }
    sed -E 's#postgres(ql)?://[^ ]+#<url>#g' -i "$OUT/migrate-phaseB.log"
    q "select count(*) from core.migrations" > "$OUT/migrations-count.txt"
    q "select name from core.migrations order by id desc limit 1" >> "$OUT/migrations-count.txt"
    log "migrations applied: $(head -1 "$OUT/migrations-count.txt") (latest $(tail -1 "$OUT/migrations-count.txt"))"
    ;;
  seed)
    assert_disposable
    log "seeding 20 orgs / 1,000 users (deterministic)"
    dc --profile ops run --rm -T tool node /cost/seed/seed.js > "$OUT/seed.log" 2>&1 || die "seed failed (see $OUT/seed.log)"
    log "backfilling processed history (real renderer)"
    dc --profile ops run --rm -T tool node /cost/seed/backfill-reports.js > "$OUT/backfill.log" 2>&1 || die "backfill failed (see $OUT/backfill.log)"
    tail -1 "$OUT/backfill.log" >&2
    q "vacuum analyze" || true
    ;;
  api)
    dc up -d api
    wait_healthy costaudit-api 240
    log "api healthy"
    ;;
  worker)
    # COST_WORKER_ENV_FILE / COST_REALTIME_ENABLED / COST_PUSH_ENABLED (see docker-compose.cost.yml) select the worker
    # configuration; a changed configuration makes compose recreate the container.
    dc up -d worker
    # Interval mode runs every scan once at boot; wait until the jobs child reports its runtime is up.
    for _ in $(seq 1 60); do docker logs costaudit-worker 2>&1 | grep -qF "[jobs]" && break; sleep 2; done
    log "worker running ($(docker inspect -f '{{.State.Status}}' costaudit-worker))"
    ;;
  app)
    "$0" api
    "$0" worker
    ;;
  down)
    # `-p crewflow-cost` scopes containers, the network and `-v` (named volumes crewflow-cost_* plus anonymous volumes
    # of this project's containers) to this project. The tracer/pdf-bench containers are not compose-managed: they are
    # removed by name through the container guard.
    assert_project_scope
    hdocker_try rm -f costaudit-trace costaudit-pdfbench costaudit-worker2
    dc --profile ops --profile replica down -v --remove-orphans
    ;;
  *) die "unknown step $1" ;;
esac
