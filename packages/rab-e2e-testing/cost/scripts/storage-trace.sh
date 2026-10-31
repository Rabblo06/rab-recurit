#!/usr/bin/env bash
# Storage-operation counter: records EVERY S3 call MinIO serves, via `mc admin trace --json`, in a separate tracer
# container on the cost network (it adds no S3 calls of its own; only the admin trace stream).
#   scripts/storage-trace.sh start <label>     begin recording
#   scripts/storage-trace.sh stop  <label>     stop, save $OUT/storage-<label>.trace.jsonl, print per-API counts
# Counting/attribution is done by lib/storage-ops.js (by S3 API, by client container, per stored_file row).
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
load_secrets
OUT="${OUT:?OUT (results dir) not set}"; assert_outside_main "the results directory (OUT)" "$OUT"
IMG="${COST_MINIO_IMAGE:-pgsty/minio@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372}"
label="${2:?label}"
case "${1:?start|stop}" in
  start)
    hdocker_try rm -f costaudit-trace
    docker run -d --name costaudit-trace --label "$COST_HARNESS_LABEL=true" --network crewflow-cost-net \
      -e "MC_HOST_cost=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PW}@costaudit-minio:9000" \
      --entrypoint mc "$IMG" admin trace --json cost >/dev/null
    sleep 2
    date -u +%FT%T.%3NZ > "$OUT/storage-$label.t-start"
    log "storage trace '$label' started"
    ;;
  stop)
    sleep 2
    date -u +%FT%T.%3NZ > "$OUT/storage-$label.t-end"
    hdocker stop costaudit-trace
    docker logs costaudit-trace 2>/dev/null | grep '^{' > "$OUT/storage-$label.trace.jsonl" || true
    hdocker rm costaudit-trace
    docker network inspect crewflow-cost-net --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}' > "$OUT/storage-$label.clients.txt"
    log "storage trace '$label' stopped: $(wc -l < "$OUT/storage-$label.trace.jsonl") S3 calls recorded"
    ;;
  *) die "start|stop" ;;
esac
