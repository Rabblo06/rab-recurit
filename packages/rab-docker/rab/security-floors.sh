#!/bin/sh
# Crewflow image security floors: fail-closed minimum-version gates, run at BUILD time inside an image stage.
#
#   sh security-floors.sh <floors-file> <check>...
#
#   node                    /usr/local/bin/node must be >= MIN_NODE_VERSION
#   alpine                  /etc/alpine-release and EVERY /etc/apk/repositories entry must be the stable ALPINE_BRANCH
#                           (https://dl-cdn.alpinelinux.org, main or community only): no edge, no tagged (@...) repository,
#                           no branch mixing, no repositories.d drop-in, no /etc/apk/config, no name@tag pin in world
#   apk-required:<pkg>      <pkg> must be installed and >= MIN_<PKG>_VERSION
#   apk-if-installed:<pkg>  if <pkg> is installed it must be >= MIN_<PKG>_VERSION (absence is fine)
#   apk-absent:<pkg>        <pkg> must NOT be installed
#
# Floors come from <floors-file> (packages/rab-docker/rab/security-floors.env, KEY=VALUE, parsed, never sourced). An
# environment variable of the same name (a Docker build ARG) may RAISE a floor but never lower it: the higher value wins.
# Every failure, including a floor or version that cannot be parsed or compared, exits non-zero. There is no warn mode.
set -eu

die() {
  echo "security-floor: FATAL - $*" >&2
  exit 1
}

FLOORS="${1:-}"
[ -n "$FLOORS" ] && [ -f "$FLOORS" ] || die "floors file missing: '${FLOORS}'"
shift
[ "$#" -gt 0 ] || die "no checks requested"

# <a> <b> -> '<', '=' or '>' for X.Y.Z Node versions; non-zero exit on anything else.
node_cmp() {
  node -e '
    const parse = (v) => { if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)) process.exit(3); return v.split(".").map(Number); };
    const a = parse(process.argv[1]);
    const b = parse(process.argv[2]);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) { process.stdout.write(a[i] < b[i] ? "<" : ">"); process.exit(0); }
    process.stdout.write("=");
  ' "$1" "$2"
}

# <a> <b> -> '<', '=' or '>' for Alpine package versions; non-zero exit on anything else.
apk_cmp() {
  apk version -c "$1" > /dev/null 2>&1 || return 3
  apk version -c "$2" > /dev/null 2>&1 || return 3
  r="$(apk version -t "$1" "$2")" || return 3
  case "$r" in '<' | '=' | '>') printf '%s' "$r" ;; *) return 3 ;; esac
}

# <KEY> <cmp-function> -> the effective floor: max(floors-file value, build-arg value).
floor() {
  key="$1"
  cmp="$2"
  case "$key" in *[!A-Z0-9_]* | '') die "invalid floor key '$key'" ;; esac
  n="$(grep -c "^${key}=" "$FLOORS" || true)"
  [ "$n" = 1 ] || die "$key must be defined exactly once in $(basename "$FLOORS") (found $n)"
  file_val="$(sed -n "s/^${key}=//p" "$FLOORS")"
  [ -n "$file_val" ] || die "$key is empty in $(basename "$FLOORS")"
  eval "arg_val=\${$key:-}"
  if [ -z "$arg_val" ] || [ "$arg_val" = "$file_val" ]; then
    printf '%s' "$file_val"
    return 0
  fi
  r="$($cmp "$arg_val" "$file_val")" || die "build argument $key='$arg_val' is not a valid version"
  if [ "$r" = '>' ]; then
    echo "security-floor: $key raised by build argument: $file_val -> $arg_val" >&2
    printf '%s' "$arg_val"
  else
    echo "security-floor: build argument $key='$arg_val' is below the committed floor $file_val and is ignored" >&2
    printf '%s' "$file_val"
  fi
}

check_node() {
  min="$(floor MIN_NODE_VERSION node_cmp)" || exit 1
  have="$(node -p 'process.versions.node')" || die "node is not runnable"
  r="$(node_cmp "$have" "$min")" || die "cannot compare node '$have' with floor '$min'"
  [ "$r" != '<' ] || die "node $have is below the security floor $min (MIN_NODE_VERSION): bump the node:24-alpine digest"
  echo "security-floor: OK node $have >= $min"
}

check_alpine() {
  branch="$(sed -n 's/^ALPINE_BRANCH=//p' "$FLOORS")"
  case "$branch" in v[0-9]*.[0-9]*) ;; *) die "ALPINE_BRANCH '$branch' is not of the form vMAJOR.MINOR" ;; esac
  case "$branch" in *[!v0-9.]*) die "ALPINE_BRANCH '$branch' is not of the form vMAJOR.MINOR" ;; esac
  rel="$(cut -d. -f1,2 /etc/alpine-release)"
  [ "v$rel" = "$branch" ] || die "base image is Alpine $rel, expected $branch"
  esc="$(printf '%s' "$branch" | sed 's/\./\\./g')"
  repos="$(grep -v -E '^[[:space:]]*(#|$)' /etc/apk/repositories || true)"
  [ -n "$repos" ] || die "/etc/apk/repositories lists no repository"
  bad="$(printf '%s\n' "$repos" | grep -v -E "^https://dl-cdn\.alpinelinux\.org/alpine/${esc}/(main|community)/?$" || true)"
  [ -z "$bad" ] || die "repository outside https://dl-cdn.alpinelinux.org stable $branch main/community (edge, tagged, other host or mixed): $bad"
  # Security review H1-L1: apk also reads repositories from repositories.d drop-ins and options from an apk config file,
  # and a world entry pinned to a tagged repository (name@tag) would pull from it. None of these may exist.
  for d in /etc/apk/repositories.d /lib/apk/repositories.d; do
    [ ! -L "$d" ] || die "apk repository drop-in directory is a symlink: $d"
    if [ -e "$d" ]; then
      extra="$(find "$d" -mindepth 1 -print | head -n 5)"
      [ -z "$extra" ] || die "apk repository drop-ins present in $d: $extra"
    fi
  done
  for f in /etc/apk/config /lib/apk/config; do
    [ ! -e "$f" ] || die "apk configuration file present: $f"
  done
  [ -f /etc/apk/world ] || die "/etc/apk/world missing"
  pinned="$(grep '@' /etc/apk/world || true)"
  [ -z "$pinned" ] || die "/etc/apk/world pins a package to a tagged repository: $pinned"
  echo "security-floor: OK alpine $(cat /etc/alpine-release), repositories = dl-cdn.alpinelinux.org $branch main/community only; no drop-ins, apk config or tag pins"
}

installed_version() {
  raw="$(apk query --installed --fields version "$1")" || die "apk query failed for $1"
  out="$(printf '%s\n' "$raw" | sed -n 's/^Version: //p')"
  [ "$(printf '%s' "$out" | grep -c '')" -le 1 ] || die "more than one installed version of $1: $out"
  # Cross-check with a second apk query so a silent query failure can never read as "not installed".
  if apk info -e "$1" > /dev/null 2>&1; then
    [ -n "$out" ] || die "apk reports $1 installed but its version could not be read"
  else
    [ -z "$out" ] || die "apk disagrees about whether $1 is installed"
  fi
  printf '%s' "$out"
}

check_apk() { # <mode> <pkg>
  mode="$1"
  pkg="$2"
  case "$pkg" in *[!a-z0-9._+-]* | '') die "invalid package name '$pkg'" ;; esac
  have="$(installed_version "$pkg")" || exit 1
  if [ "$mode" = absent ]; then
    [ -z "$have" ] || die "$pkg $have is installed but must not be in this image"
    echo "security-floor: OK $pkg not installed"
    return 0
  fi
  if [ -z "$have" ]; then
    [ "$mode" = if-installed ] || die "$pkg is not installed"
    echo "security-floor: OK $pkg not installed (floor applies only if present)"
    return 0
  fi
  key="MIN_$(printf '%s' "$pkg" | tr 'a-z.+-' 'A-Z___')_VERSION"
  min="$(floor "$key" apk_cmp)" || exit 1
  r="$(apk_cmp "$have" "$min")" || die "cannot compare $pkg '$have' with floor '$min'"
  [ "$r" != '<' ] || die "$pkg $have is below the security floor $min ($key): the stable repository has not shipped the fix yet, or the apk layer is stale (rebuild with --no-cache)"
  echo "security-floor: OK $pkg $have >= $min"
}

for c in "$@"; do
  case "$c" in
    node) check_node ;;
    alpine) check_alpine ;;
    apk-required:*) check_apk required "${c#apk-required:}" ;;
    apk-if-installed:*) check_apk if-installed "${c#apk-if-installed:}" ;;
    apk-absent:*) check_apk absent "${c#apk-absent:}" ;;
    *) die "unknown check '$c'" ;;
  esac
done
