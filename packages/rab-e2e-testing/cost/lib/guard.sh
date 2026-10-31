#!/usr/bin/env bash
# Isolation guards for the crewflow-cost harness. Sourced by lib/common.sh; never executed.
#
# The harness shares the Docker host with the owner's normal development stack and must never change it. Since
# 2026-10-27 it never stops, restarts, removes or reconfigures anything it did not create, and it never mounts the main
# checkout. These functions enforce that:
#
#   assert_outside_main <what> <path>   refuses a harness path (work dir, out dir, secrets, the harness itself) that lies
#                                       inside the main checkout ($COST_MAIN_CHECKOUT, default C:/Rab-recruit)
#   assert_harness_container <name>     refuses any container that is not harness-owned (name costaudit-* AND label
#                                       com.docker.compose.project=crewflow-cost or crewflow-cost.harness=true);
#                                       an absent container passes (nothing to act on)
#   hdocker / hdocker_try <verb> ...    the ONLY way the shell scripts stop/start/rm/pause/unpause a container
#   assert_project_scope                before `compose down -v`: every resource labelled with the project must carry a
#                                       harness name, or nothing is removed
#   check_compose_isolation             static check of the rendered compose model (mounts, ports, networks, volumes)
#   check_ports_subnet                  host ports and the subnet are not used by anything else
#   drift_snapshot / drift_check        main-checkout drift guard (aborts the run on any change)
#   devstate_snapshot / devstate_check  dev-container state guard (report only; never acts on them)
#   host_state_record                   records which non-harness containers are running (run metadata)

COST_MAIN_CHECKOUT="${COST_MAIN_CHECKOUT:-/c/Rab-recruit}"
COST_HARNESS_LABEL=crewflow-cost.harness
# Containers whose state is recorded and re-verified at every checkpoint (report only). Extended regex on the name.
COST_DEV_WATCH_REGEX="${COST_DEV_WATCH_REGEX:-^(rab-|crewflow-test-)}"
# Host ports used by the dev stack (3000, 5173, 15432), crewflow-test-* (15436, 16391-16399) and the e2e stack
# (3300, 15470, 16470). The harness may never publish on one of them.
COST_RESERVED_PORTS="3000 5173 15432 15436 16391 16392 16393 16394 16395 16396 16397 16398 16399 3300 15470 16470"

# ---- paths ----------------------------------------------------------------------------------------------------------
# Lower-case, forward-slash, absolute, no trailing slash. /c/x, C:\x and c:/x all compare equal.
norm_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then p="$(cygpath -m -a "$p" 2>/dev/null || printf '%s' "$p")"; fi
  p="${p//\\//}"; p="${p%/}"
  printf '%s' "$p" | tr '[:upper:]' '[:lower:]'
}
path_is_under() { # child parent
  local c p
  c="$(norm_path "$1")/"; p="$(norm_path "$2")/"
  case "$c" in "$p"*) return 0 ;; esac
  return 1
}
assert_outside_main() { # what path
  [ -n "${2:-}" ] || return 0
  if path_is_under "$2" "$COST_MAIN_CHECKOUT"; then
    die "isolation: $1 ($2) is inside the main checkout $COST_MAIN_CHECKOUT; the harness never writes there or mounts it"
  fi
}

# ---- container guard ------------------------------------------------------------------------------------------------
assert_harness_container() { # name
  local n="$1" info
  case "$n" in
    costaudit-*) ;;
    *) die "container guard: refusing to act on '$n' (not a costaudit-* harness container)" ;;
  esac
  case "$n" in *[!A-Za-z0-9_.-]*) die "container guard: refusing malformed name '$n'" ;; esac
  info="$(docker container inspect -f "{{index .Config.Labels \"com.docker.compose.project\"}}|{{index .Config.Labels \"$COST_HARNESS_LABEL\"}}" "$n" 2>/dev/null)" || return 0 # absent
  case "$info" in
    "$COST_PROJECT|"* | *"|true") return 0 ;;
  esac
  die "container guard: '$n' exists but carries neither com.docker.compose.project=$COST_PROJECT nor $COST_HARNESS_LABEL=true; refusing to touch it"
}
# hdocker <stop|start|rm|pause|unpause> [-f] <costaudit-*>...   guarded; docker's stdout discarded, errors propagate.
# Flags that take a value (stop -t 30) are not supported on purpose: every non-flag argument is a container name.
hdocker() {
  local verb="${1:?verb}" a; shift
  case "$verb" in stop | start | rm | pause | unpause) ;; *) die "hdocker: verb '$verb' is not allowed" ;; esac
  [ "$#" -gt 0 ] || die "hdocker: no container"
  for a in "$@"; do case "$a" in -f | --force) ;; -*) die "hdocker: flag '$a' not allowed" ;; *) assert_harness_container "$a" ;; esac; done
  docker "$verb" "$@" >/dev/null
}
# Same guard (a refusal still aborts, visibly), but a docker failure (e.g. the container is absent) is ignored.
hdocker_try() {
  local verb="${1:?verb}" a; shift
  case "$verb" in stop | start | rm | pause | unpause) ;; *) die "hdocker: verb '$verb' is not allowed" ;; esac
  for a in "$@"; do case "$a" in -f | --force) ;; -*) die "hdocker: flag '$a' not allowed" ;; *) assert_harness_container "$a" ;; esac; done
  docker "$verb" "$@" >/dev/null 2>&1 || true
}

# Before `compose down -v --remove-orphans`: compose removes by project label. Refuse if anything carrying the label
# does not also carry a harness name (it would mean a foreign resource was mislabelled into the project).
assert_project_scope() {
  local bad="" n
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    case "$n" in costaudit-* | "$COST_PROJECT"-*) ;; *) bad="$bad container:$n" ;; esac
  done < <(docker ps -a --filter "label=com.docker.compose.project=$COST_PROJECT" --format '{{.Names}}')
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    case "$n" in "$COST_PROJECT"_*) ;; *) bad="$bad volume:$n" ;; esac
  done < <(docker volume ls --filter "label=com.docker.compose.project=$COST_PROJECT" --format '{{.Name}}')
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    case "$n" in "$COST_PROJECT"-net | "$COST_PROJECT"_*) ;; *) bad="$bad network:$n" ;; esac
  done < <(docker network ls --filter "label=com.docker.compose.project=$COST_PROJECT" --format '{{.Name}}')
  # A network of ours with a foreign container attached would make `down` fail; report it rather than disconnect it.
  if docker network inspect "$COST_PROJECT-net" >/dev/null 2>&1; then
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      case "$n" in costaudit-* | "$COST_PROJECT"-*) ;; *) bad="$bad foreign-container-on-$COST_PROJECT-net:$n" ;; esac
    done < <(docker network inspect "$COST_PROJECT-net" --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}')
  fi
  [ -z "$bad" ] || die "project scope guard: refusing to tear down; non-harness resources in scope:$bad"
}

# ---- static isolation checks ----------------------------------------------------------------------------------------
# Renders the compose model (secrets are interpolated into it, so it goes straight into the checker on a pipe; it is
# never written anywhere and the checker prints names, targets and ports only).
check_compose_isolation() {
  local tag="${COST_TAG:-isolationcheck}"
  COST_TAG="$tag" dc --profile ops --profile replica config --format json |
    COST_DIR_W="$(hostpath "$COST_DIR")" COST_MAIN_W="$(hostpath "$COST_MAIN_CHECKOUT")" COST_PROJECT="$COST_PROJECT" \
      COST_RESERVED_PORTS="$COST_RESERVED_PORTS" node "$(hostpath "$COST_DIR/lib/check-compose.js")"
}

ip2int() { local IFS=.; set -- $1; echo $((($1 << 24) + ($2 << 16) + ($3 << 8) + $4)); }
cidr_overlap() { # a/len b/len (IPv4)
  local a="${1%/*}" al="${1#*/}" b="${2%/*}" bl="${2#*/}" m mask
  m=$((al < bl ? al : bl))
  mask=$((m == 0 ? 0 : (0xFFFFFFFF << (32 - m)) & 0xFFFFFFFF))
  [ $(($(ip2int "$a") & mask)) -eq $(($(ip2int "$b") & mask)) ]
}
check_ports_subnet() {
  local bad="" p r line name net sub
  for p in "$COST_PG_PORT" "$COST_REDIS_PORT" "$COST_MINIO_PORT" "$COST_API_PORT"; do
    for r in $COST_RESERVED_PORTS; do [ "$p" = "$r" ] && bad="$bad port:$p(reserved-dev-port)"; done
    local ours=0 foreign=""
    while IFS=$'\t' read -r name line; do
      case "$line" in *":$p->"*) case "$name" in costaudit-*) ours=1 ;; *) foreign="$foreign $name" ;; esac ;; esac
    done < <(docker ps --format '{{.Names}}{{"\t"}}{{.Ports}}')
    [ -z "$foreign" ] || bad="$bad port:$p(published-by:${foreign# })"
    if [ "$ours" = 0 ] && command -v netstat >/dev/null 2>&1 && netstat -ano -p TCP 2>/dev/null | tr -d '\r' | grep -E "LISTENING" | grep -qE "[:.]$p[[:space:]]"; then
      bad="$bad port:$p(host-listener)"
    fi
  done
  while IFS=$'\t' read -r net sub; do
    [ "$net" = "$COST_PROJECT-net" ] && continue
    for s in $sub; do
      case "$s" in *:*) continue ;; */*) ;; *) continue ;; esac
      cidr_overlap "$s" "$COST_SUBNET" && bad="$bad subnet:$COST_SUBNET(overlaps-$net-$s)"
    done
  done < <(docker network inspect $(docker network ls -q) --format '{{.Name}}{{"\t"}}{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null)
  [ -z "$bad" ] || die "port/subnet guard:$bad"
  log "ports $COST_PG_PORT/$COST_REDIS_PORT/$COST_MINIO_PORT/$COST_API_PORT and subnet $COST_SUBNET are free of non-harness use"
}

# ---- main-checkout drift guard --------------------------------------------------------------------------------------
# A snapshot is three files: head.txt (HEAD + branch), status.txt (`git status --porcelain=v1 -uall`) and files.tsv
# (path, size, sha256) for yarn.lock, .yarnrc.yml, every package.json (tracked and untracked-not-ignored) and every
# path the status lists, so a further change to an already-dirty file is caught too. All git calls are read-only and
# run with GIT_OPTIONAL_LOCKS=0, so `git status` does not even refresh the index of the main checkout.
_main_git() { GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$COST_MAIN_CHECKOUT")" -c core.quotepath=false "$@"; }
_status_paths_z() { # porcelain -z on stdin -> NUL-separated paths (both sides of a rename/copy)
  local rec
  while IFS= read -r -d '' rec; do
    printf '%s\0' "${rec:3}"
    case "${rec:0:2}" in R* | C*) IFS= read -r -d '' rec && printf '%s\0' "$rec" ;; esac
  done
}
drift_snapshot() { # dir
  local d="$1" m p
  m="$(hostpath "$COST_MAIN_CHECKOUT")"
  _main_git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "drift guard: $COST_MAIN_CHECKOUT is not a git work tree"
  mkdir -p "$d"
  { echo "HEAD $(_main_git rev-parse HEAD)"; echo "REF $(_main_git symbolic-ref -q HEAD || echo detached)"; } > "$d/head.txt"
  _main_git status --porcelain=v1 -uall > "$d/status.txt"
  {
    _main_git ls-files -z -co --exclude-standard -- yarn.lock .yarnrc.yml ':(glob)**/package.json'
    _main_git status --porcelain=v1 -uall -z | _status_paths_z
  } | sort -zu | while IFS= read -r -d '' p; do
    if [ -f "$m/$p" ]; then
      printf '%s\t%s\t%s\n' "$p" "$(wc -c < "$m/$p" | tr -d ' ')" "$(sha256sum < "$m/$p" | cut -c1-64)"
    elif [ -e "$m/$p" ]; then
      printf '%s\t%s\t%s\n' "$p" "not-a-file" "-"
    else
      printf '%s\t%s\t%s\n' "$p" "missing" "-"
    fi
  done > "$d/files.tsv"
}
# drift_check <baseline dir> <phase> <report dir>: 0 = unchanged; 1 = changed, report written and printed.
drift_check() {
  local base="$1" phase="$2" rdir="$3" now report
  now="$rdir/guard/main-checkout-after-$phase"
  rm -rf "$now"; drift_snapshot "$now"
  report="$rdir/main-checkout-drift-$phase.txt"
  {
    cmp -s "$base/head.txt" "$now/head.txt" || { echo "## HEAD/branch changed"; diff "$base/head.txt" "$now/head.txt" | grep -E '^[<>]' || true; }
    if ! cmp -s "$base/status.txt" "$now/status.txt"; then
      echo "## git status --porcelain=v1 -uall changed (< before, > after)"
      diff <(sort "$base/status.txt") <(sort "$now/status.txt") | grep -E '^[<>]' || true
    fi
    awk -F'\t' 'NR==FNR { a[$1] = $2 " " $3; next } { b[$1] = $2 " " $3 }
      END {
        for (k in a) if (!(k in b)) print "removed-from-watch-set\t" k "\t" a[k]; else if (a[k] != b[k]) print "content-changed\t" k "\t" a[k] " -> " b[k]
        for (k in b) if (!(k in a)) print "new-in-watch-set\t" k "\t" b[k]
      }' "$base/files.tsv" "$now/files.tsv" | sort | sed '1s/^/## watched files (size sha256)\n/'
  } > "$report.tmp"
  if [ -s "$report.tmp" ]; then
    { echo "MAIN CHECKOUT DRIFT detected after phase '$phase' at $(date -u +%FT%TZ)"; echo "main checkout: $COST_MAIN_CHECKOUT"; echo "baseline: $base"; echo; cat "$report.tmp"; } > "$report"
    rm -f "$report.tmp"
    cp "$report" "$rdir/MAIN-CHECKOUT-DRIFT.txt"
    echo "[cost] ===== main checkout changed during the run =====" >&2
    cat "$report" >&2
    return 1
  fi
  rm -f "$report.tmp" "$report"
  return 0
}

# ---- dev-container state guard (report only) -------------------------------------------------------------------------
# name, status, startedAt, restartCount (compared) and health (reported). Read-only `docker inspect`; never acts.
devstate_snapshot() {
  local names
  names="$(docker ps -a --format '{{.Names}}' | grep -E "$COST_DEV_WATCH_REGEX" || true)"
  [ -n "$names" ] || return 0
  # shellcheck disable=SC2086
  docker inspect -f '{{.Name}}{{"\t"}}{{.State.Status}}{{"\t"}}{{.State.StartedAt}}{{"\t"}}{{.RestartCount}}{{"\t"}}{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' $names 2>/dev/null | sed 's#^/##' | sort
}
# devstate_check <baseline file> <phase> <report dir>: 0 = unchanged; 1 = changed (logged, run continues).
devstate_check() {
  local base="$1" phase="$2" rdir="$3" now d
  now="$rdir/guard/dev-containers-after-$phase.tsv"
  devstate_snapshot > "$now"
  d="$(diff <(cut -f1-4 "$base") <(cut -f1-4 "$now") | grep -E '^[<>]' || true)"
  if [ -n "$d" ]; then
    {
      echo "$(date -u +%FT%TZ) after phase '$phase': dev container state differs from run start (the harness did not act on them; report only)"
      echo "$d" | sed 's/^/  /'
    } | tee -a "$rdir/dev-containers-changes.log" >&2
    : > "$rdir/guard/dev-state-changed"
    return 1
  fi
  return 0
}

# Run metadata: what else was running on the Docker host (for comparability of before/after runs).
host_state_record() { # file label
  local f="$1" label="$2"
  {
    echo "# $label $(date -u +%FT%TZ)"
    echo "docker.vm ncpu=$(docker info -f '{{.NCPU}}') memBytes=$(docker info -f '{{.MemTotal}}')"
    echo "## running non-harness containers (name, image, status)"
    docker ps --format '{{.Names}}{{"\t"}}{{.Image}}{{"\t"}}{{.Status}}' | grep -vE '^(costaudit-|crewflow-cost-)' | sort || true
    echo "## docker stats snapshot of non-harness containers (name, cpu, mem)"
    local names
    names="$(docker ps --format '{{.Names}}' | grep -vE '^(costaudit-|crewflow-cost-)' || true)"
    # shellcheck disable=SC2086
    [ -z "$names" ] || docker stats --no-stream --format '{{.Name}}{{"\t"}}{{.CPUPerc}}{{"\t"}}{{.MemUsage}}' $names 2>/dev/null | sort || true
  } >> "$f"
}
