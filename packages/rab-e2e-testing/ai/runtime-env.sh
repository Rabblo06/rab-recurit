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

# X1.8: the admin (superuser) connection values. Any OTHER exported name holding exactly one of these values (the superuser
# URL copied under a name this file does not list, e.g. in the caller's env file) is removed from every child but the seed
# too, so the deny-list above is not the only line.
AI_E2E_STRIPPED_VALUE_SOURCES=(TEST_DATABASE_URL_UNPOOLED MIGRATION_SECURITY_ADMIN_URL)

# Prints, one per line, every exported name whose value equals a non-empty AI_E2E_STRIPPED_VALUE_SOURCES value. Values are
# compared, never printed.
ai_e2e_admin_value_aliases() {
  local src value name
  for src in "${AI_E2E_STRIPPED_VALUE_SOURCES[@]}"; do
    value="${!src:-}"
    [ -n "$value" ] || continue
    while IFS= read -r name; do
      [ "${!name:-}" = "$value" ] && printf '%s\n' "$name"
    done < <(compgen -e)
  done
  return 0
}

# Replaces the current (sub)shell with "$@", minus AI_E2E_STRIPPED_NAMES and any admin-value alias. For the API and the Worker.
ai_e2e_runtime_exec() {
  local unset_args=() name
  for name in "${AI_E2E_STRIPPED_NAMES[@]}"; do unset_args+=(-u "$name"); done
  while IFS= read -r name; do unset_args+=(-u "$name"); done < <(ai_e2e_admin_value_aliases)
  exec env "${unset_args[@]}" "$@"
}

# Replaces the current (sub)shell with "$@", minus AI_E2E_STRIPPED_NAMES, AI_E2E_CLIENT_STRIPPED_NAMES and any admin-value
# alias. For Vite and Playwright.
ai_e2e_client_exec() {
  local unset_args=() name
  for name in "${AI_E2E_STRIPPED_NAMES[@]}" "${AI_E2E_CLIENT_STRIPPED_NAMES[@]}"; do unset_args+=(-u "$name"); done
  while IFS= read -r name; do unset_args+=(-u "$name"); done < <(ai_e2e_admin_value_aliases)
  exec env "${unset_args[@]}" "$@"
}
