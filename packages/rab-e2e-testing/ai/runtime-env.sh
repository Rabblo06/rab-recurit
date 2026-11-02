# shellcheck shell=bash
# Sourced by run-ai-e2e.sh (and by run-ai-e2e-env.test.cjs, which runs these exact functions). Audit DBT-12 / X1.3.
#
# The env file run-ai-e2e.sh sources (`set -a`) holds the disposable cluster's test credentials: TEST_DATABASE_URL_UNPOOLED is
# its bootstrap SUPERUSER. The seed needs that admin connection (fixtures, the disposable-marker proof) and keeps it. Every
# long-running child (the API, the rab-ai consumer, Vite, Playwright) is started through one of the functions below, which
# remove these names from that child's environment, so no superuser URL, role bootstrap password or command authority sits in
# a runtime process (readable through /proc/<pid>/environ, crash dumps or anything the process spawns). The API and the
# Worker connect through PG_DATABASE_URL only (the restricted crewflow_app login), exactly as run-live.sh starts its API.

# Never in any child but the seed.
AI_E2E_STRIPPED_NAMES=(
  TEST_DATABASE_URL TEST_DATABASE_URL_UNPOOLED TEST_DATABASE_CREWFLOW_URL TEST_DATABASE_WORKER_URL
  MIGRATION_SECURITY_ADMIN_URL
  CREWFLOW_BOOTSTRAP_PASSWORD CREWFLOW_APP_BOOTSTRAP_PASSWORD CREWFLOW_WORKER_BOOTSTRAP_PASSWORD CREWFLOW_MIGRATOR_PASSWORD
  DATABASE_URL DATABASE_URL_UNPOOLED DATABASE_DIRECT_URL
  DB_TARGET ALLOW_PRODUCTION_DB_COMMANDS
)
# Additionally never in a client process (Vite, Playwright): it needs no database URL and no application secret.
AI_E2E_CLIENT_STRIPPED_NAMES=(PG_DATABASE_URL APP_SECRET)

# Replaces the current (sub)shell with "$@", minus AI_E2E_STRIPPED_NAMES. For the API and the Worker.
ai_e2e_runtime_exec() {
  local unset_args=() name
  for name in "${AI_E2E_STRIPPED_NAMES[@]}"; do unset_args+=(-u "$name"); done
  exec env "${unset_args[@]}" "$@"
}

# Replaces the current (sub)shell with "$@", minus AI_E2E_STRIPPED_NAMES and AI_E2E_CLIENT_STRIPPED_NAMES. For Vite and
# Playwright.
ai_e2e_client_exec() {
  local unset_args=() name
  for name in "${AI_E2E_STRIPPED_NAMES[@]}" "${AI_E2E_CLIENT_STRIPPED_NAMES[@]}"; do unset_args+=(-u "$name"); done
  exec env "${unset_args[@]}" "$@"
}
