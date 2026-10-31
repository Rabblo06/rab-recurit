#!/usr/bin/env bash
# Generates fresh random DISPOSABLE secrets for the cost stack into $COST_SECRETS (outside the repo).
# Refuses to overwrite an existing file unless --force. Prints only the path, never a value.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
[ "${1:-}" = "--force" ] || { [ -f "$COST_SECRETS" ] && { log "secrets exist at $COST_SECRETS (use --force to regenerate; requires a fresh stack)"; exit 0; }; }
path_is_under "$COST_SECRETS" "$REPO" && die "COST_SECRETS must be outside the repo"
assert_outside_main COST_SECRETS "$COST_SECRETS"
mkdir -p "$(dirname "$COST_SECRETS")"
rnd() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }
umask 077
cat > "$COST_SECRETS" <<EOF
# Disposable secrets for the crewflow-cost measurement stack. Generated $(date -u +%FT%TZ). Never reuse elsewhere.
PG_SUPER_PW=$(rnd 18)
RAB_OWNER_PW=$(rnd 18)
CREWFLOW_PW=$(rnd 18)
CREWFLOW_APP_PW=$(rnd 18)
REDIS_PW=$(rnd 18)
MINIO_ROOT_USER=costaudit$(rnd 4)
MINIO_ROOT_PW=$(rnd 18)
MINIO_KMS_SECRET_KEY=costaudit-key:$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")
APP_SECRET=$(rnd 32)
STORAGE_KEY_PREFIX=costaudit
SEED_PW=Cost$(rnd 10)
EOF
log "wrote $COST_SECRETS"
