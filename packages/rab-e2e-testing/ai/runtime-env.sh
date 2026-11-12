# shellcheck shell=bash
# Sourced by run-ai-e2e.sh (and by run-ai-e2e-env.test.cjs, which runs these exact functions). Audit DBT-12 / X1.3 / X1.8.
#
# The env file run-ai-e2e.sh sources (`set -a`) holds the disposable cluster's test credentials: TEST_DATABASE_URL_UNPOOLED is
# its bootstrap SUPERUSER. The seed needs that admin connection (fixtures, the disposable-marker proof) and keeps it. Every
# long-running child (the API, the rab-ai consumer, Vite, Playwright) is started through one of the functions below, which
# remove these names from that child's environment, so no superuser URL, role bootstrap password or command authority sits in
# a runtime process (readable through /proc/<pid>/environ, crash dumps or anything the process spawns). The API and the
# Worker connect through PG_DATABASE_URL only (the restricted runtime login), exactly as run-live.sh starts its API.
#
# X1.8 (security review of #27): this is a DENY-list (by name, by name pattern and by value), not an allow-list. An allow-list
# (env -i + named variables) was considered and not taken: the real harness cannot be run in review (its database is the
# shared crewflow-test-db), and an allow-list would silently drop whatever a caller's env file and the platform (Windows
# SystemRoot / APPDATA / LOCALAPPDATA for Playwright's browsers, Vite's VITE_*) need. Residual: a NEW credential that is
# neither listed, nor PG* / POSTGRES_*, nor carries the admin password (8+ characters) still reaches the children.

# Never in any child but the seed.
AI_E2E_STRIPPED_NAMES=(
  TEST_DATABASE_URL TEST_DATABASE_URL_UNPOOLED TEST_DATABASE_CREWFLOW_URL TEST_DATABASE_WORKER_URL
  MIGRATION_SECURITY_ADMIN_URL
  CREWFLOW_BOOTSTRAP_PASSWORD CREWFLOW_APP_BOOTSTRAP_PASSWORD CREWFLOW_WORKER_BOOTSTRAP_PASSWORD CREWFLOW_MIGRATOR_PASSWORD
  DATABASE_URL DATABASE_URL_UNPOOLED DATABASE_DIRECT_URL
  DB_TARGET ALLOW_PRODUCTION_DB_COMMANDS
  DOTENV_CONFIG_PATH
)
# Additionally never in a client process (Vite, Playwright): it needs no database URL and no application secret.
AI_E2E_CLIENT_STRIPPED_NAMES=(PG_DATABASE_URL APP_SECRET)

# X1.8: the admin (superuser) connection values. Any OTHER exported name holding one of these values, or (when it is 8 or more
# characters) the password inside one of them, raw or percent-decoded, is removed from every child but the seed too.
AI_E2E_STRIPPED_VALUE_SOURCES=(TEST_DATABASE_URL_UNPOOLED MIGRATION_SECURITY_ADMIN_URL)
AI_E2E_MIN_PASSWORD_MATCH=8

# Prints the password part of a postgres URL (as written, possibly percent-encoded), or nothing.
ai_e2e_url_password() {
  local url="$1" rest auth userinfo
  rest="${url#*://}"
  [ "$rest" != "$url" ] || return 0
  auth="${rest%%/*}"
  auth="${auth%%\?*}"
  case "$auth" in *@*) ;; *) return 0 ;; esac
  userinfo="${auth%@*}"
  case "$userinfo" in *:*) printf '%s' "${userinfo#*:}" ;; esac
  return 0
}

# Percent-decodes $1 (%XX only; `+` is literal in a URL's userinfo).
ai_e2e_percent_decode() {
  local s="${1//\\/\\\\}"
  printf '%b' "${s//%/\\x}"
}

# Lists the exported environment as NUL-separated NAME=value entries, straight from `env -0`: unlike `compgen -e` this includes
# names bash itself cannot use as variables (e.g. `ADMIN.URL`, which a child still inherits).
ai_e2e_env_entries() {
  env -0
}

# Prints, one per line, every exported name that is a libpq PG* variable (PGPASSWORD, PGHOST, ...), a PG_*URL other than
# PG_DATABASE_URL, or a POSTGRES_* variable (the image's POSTGRES_PASSWORD / POSTGRES_USER).
ai_e2e_pattern_names() {
  local entry name
  while IFS= read -r -d '' entry; do
    name="${entry%%=*}"
    if [[ "$name" =~ ^PG[A-Z0-9]*$ ]] || [[ "$name" =~ ^POSTGRES_ ]] || { [[ "$name" =~ ^PG_.*URL$ ]] && [ "$name" != PG_DATABASE_URL ]; }; then
      printf '%s\n' "$name"
    fi
  done < <(ai_e2e_env_entries)
  return 0
}

# Prints, one per line, every exported name (any name, see ai_e2e_env_entries) whose value equals an
# AI_E2E_STRIPPED_VALUE_SOURCES value or contains its password, the source's password and the value each compared both as
# written and percent-decoded (AI_E2E_MIN_PASSWORD_MATCH characters or more). A leading scheme (postgres://) is ignored for
# the password match, so a password that happens to spell "postgres" does not match every URL. Values are compared, never
# printed.
ai_e2e_admin_value_aliases() {
  local src value entry name v dv pw needle
  local values=() needles=()
  for src in "${AI_E2E_STRIPPED_VALUE_SOURCES[@]}"; do
    value="${!src:-}"
    [ -n "$value" ] || continue
    values+=("$value")
    pw="$(ai_e2e_url_password "$value")"
    for needle in "$pw" "$(ai_e2e_percent_decode "$pw")"; do
      [ "${#needle}" -ge "$AI_E2E_MIN_PASSWORD_MATCH" ] && needles+=("$needle")
    done
  done
  [ "${#values[@]}" -gt 0 ] || return 0
  while IFS= read -r -d '' entry; do
    name="${entry%%=*}"
    v="${entry#*=}"
    [ -n "$v" ] || continue
    for value in "${values[@]}"; do
      if [ "$v" = "$value" ]; then printf '%s\n' "$name"; continue 2; fi
    done
    v="${v#*://}"
    dv="$v"
    if [[ "$v" == *%* ]]; then
      dv="${v//\\/\\\\}"
      printf -v dv '%b' "${dv//%/\\x}"
    fi
    for needle in "${needles[@]}"; do
      if [[ "$v" == *"$needle"* ]] || [[ "$dv" == *"$needle"* ]]; then printf '%s\n' "$name"; continue 2; fi
    done
  done < <(ai_e2e_env_entries)
  return 0
}

# Replaces the current (sub)shell with "$@", minus AI_E2E_STRIPPED_NAMES, the PG* / POSTGRES_* names and any admin-value
# alias. For the API and the Worker.
ai_e2e_runtime_exec() {
  local unset_args=() name
  for name in "${AI_E2E_STRIPPED_NAMES[@]}"; do unset_args+=(-u "$name"); done
  while IFS= read -r name; do unset_args+=(-u "$name"); done < <(ai_e2e_pattern_names; ai_e2e_admin_value_aliases)
  exec env "${unset_args[@]}" "$@"
}

# Replaces the current (sub)shell with "$@", minus AI_E2E_STRIPPED_NAMES, AI_E2E_CLIENT_STRIPPED_NAMES, the PG* / POSTGRES_*
# names and any admin-value alias. For Vite and Playwright.
ai_e2e_client_exec() {
  local unset_args=() name
  for name in "${AI_E2E_STRIPPED_NAMES[@]}" "${AI_E2E_CLIENT_STRIPPED_NAMES[@]}"; do unset_args+=(-u "$name"); done
  while IFS= read -r name; do unset_args+=(-u "$name"); done < <(ai_e2e_pattern_names; ai_e2e_admin_value_aliases)
  exec env "${unset_args[@]}" "$@"
}
