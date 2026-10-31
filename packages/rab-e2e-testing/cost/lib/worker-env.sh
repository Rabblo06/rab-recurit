#!/usr/bin/env bash
# Per-phase worker configuration for the Phase A measurement. Sourced by scripts/measure.sh and scripts/check-isolation.sh
# (which tests its refusals); needs lib/common.sh (dc, hostpath, die) and OUT.

# ---- worker configuration per phase (Phase A measurement) -----------------------------------------------------------
# make_worker_env <name> [ITEM ...]: writes $OUT/worker-env/<name>.env = base.env (run.sh: --worker-env-file, else
# empty) changed by the items, and sets WENV (file), WRT / WPU (REALTIME_ENABLED / PUSH_ENABLED, which compose sets by
# interpolation because `environment:` would override an env file) and WNOURL (1 = run compose WITHOUT the pass-through
# CREWFLOW_PROVISIONER_DATABASE_URL, so the worker does not have that variable at all). Items:
#   KEY=VALUE   set KEY in the env file (replacing a base.env value)
#   -KEY        remove KEY from the env file; `-CREWFLOW_PROVISIONER_DATABASE_URL` removes the compose-provided URL
# A key that compose already sets for the worker is refused (an env-file value would be silently ignored), as is
# anything malformed.
make_worker_env() {
  local name="$1" kv k v dir="$OUT/worker-env" fixed; shift
  case "$name" in *[!A-Za-z0-9._-]*) die "worker env name '$name' must be [A-Za-z0-9._-]" ;; esac
  mkdir -p "$dir"; [ -f "$dir/base.env" ] || : > "$dir/base.env"
  WENV="$dir/$name.env"; WRT=false; WPU=false; WNOURL=0
  [ "$name" = base ] || cp "$dir/base.env" "$WENV"
  fixed="$(COST_WORKER_ENV_FILE="$(hostpath "$COST_DIR/init/empty.env")" dc config --format json worker | node -e '
    let r = ""; process.stdin.on("data", (d) => (r += d)).on("end", () => console.log(Object.keys(JSON.parse(r).services.worker.environment).join(" ")));')"
  for kv in "$@"; do
    [ -n "$kv" ] || continue
    [ "$name" != base ] || die "worker env: base.env is written by run.sh (--worker-env-file), not by worker-up"
    if [[ "$kv" =~ ^-[A-Z][A-Z0-9_]*$ ]]; then
      k="${kv#-}"
      case "$k" in
        CREWFLOW_PROVISIONER_DATABASE_URL) WNOURL=1 ;;
        REALTIME_ENABLED | PUSH_ENABLED) die "worker env: $k cannot be removed (set it to false instead)" ;;
        *)
          [[ " $fixed " != *" $k "* ]] || die "worker env: $k is set by docker-compose.cost.yml for the worker and cannot be removed"
          grep -v "^$k=" "$WENV" > "$WENV.tmp" || true; mv "$WENV.tmp" "$WENV" ;;
      esac
      continue
    fi
    [[ "$kv" =~ ^[A-Z][A-Z0-9_]*=[^[:space:]]*$ ]] || die "worker env: '$kv' is not KEY=VALUE or -KEY (no whitespace)"
    k="${kv%%=*}"; v="${kv#*=}"
    case "$k" in
      REALTIME_ENABLED) WRT="$v" ;;
      PUSH_ENABLED) WPU="$v" ;;
      *)
        [[ " $fixed " != *" $k "* ]] || die "worker env: $k is set by docker-compose.cost.yml for the worker; an env-file value would be ignored"
        grep -v "^$k=" "$WENV" > "$WENV.tmp" || true; mv "$WENV.tmp" "$WENV"
        echo "$k=$v" >> "$WENV" ;;
    esac
  done
  {
    echo "name=$name"; echo "REALTIME_ENABLED=$WRT"; echo "PUSH_ENABLED=$WPU"
    echo "provisionerUrl=$([ "$WNOURL" = 1 ] && echo absent || echo present)"
    echo "envFile=$(tr '\n' ' ' < "$WENV")"
    echo "envFileKeys=$(cut -d= -f1 "$WENV" | tr '\n' ' ')"
  } > "$dir/$name.config"
}

# wdc <compose args...>: compose with the configuration from the last make_worker_env (env file, flags, provisioner URL).
wdc() {
  (
    [ "$WNOURL" != 1 ] || unset CREWFLOW_PROVISIONER_DATABASE_URL
    export COST_WORKER_ENV_FILE COST_REALTIME_ENABLED COST_PUSH_ENABLED
    COST_WORKER_ENV_FILE="$(hostpath "$WENV")"; COST_REALTIME_ENABLED="$WRT"; COST_PUSH_ENABLED="$WPU"
    dc "$@"
  )
}

# Records, without values, whether the running container's environment has the provisioner URL and the Phase A keys.
worker_env_facts() { # container
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n 's/=.*//p' |
    grep -E '^(CREWFLOW_PROVISIONER_DATABASE_URL|CREWFLOW_PROVISIONER_ENABLED|WORKSPACE_PROVISIONER_INTERVAL_SECONDS|STORAGE_RECONCILE_METHOD|STORAGE_CLEANUP_MIN_SPACING_MINUTES|REALTIME_ENABLED|PUSH_ENABLED)$' | sort | tr '\n' ' '
}
