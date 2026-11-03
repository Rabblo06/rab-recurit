#!/usr/bin/env bash
# Docker hardening H5: CANDIDATE mode of the image gate. Instead of building, take an already-gated candidate (the merged
# multi-platform API and Worker OCI layouts a previous gate run exported, identified by their index digests) and load
# THIS platform's images from it unchanged, so the full gate (including the native PDF render) runs against exactly that
# candidate. Nothing is built, pushed or pulled from a registry.
#
#   bash load-candidate.sh <linux/amd64|linux/arm64> <out-dir> <candidate-dir> <api-index-digest> <worker-index-digest>
#
# <candidate-dir> holds api-layout/ and worker-layout/ (the gated-api-layout / gated-worker-layout artifacts). Each must
# be a single index named "gated" with exactly the given digest. Writes the same outputs as build-gate-images.sh.
set -euo pipefail
fail() {
  echo "::error::load-candidate: $*" >&2
  exit 1
}
platform="${1:-}"
out="${2:-}"
cand="${3:-}"
want_api="${4:-}"
want_worker="${5:-}"
case "$platform" in linux/amd64 | linux/arm64) ;; *) fail "usage: load-candidate.sh <platform> <out> <candidate-dir> <api-digest> <worker-digest>" ;; esac
arch="${platform#linux/}"
for d in "$want_api" "$want_worker"; do [[ "$d" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "candidate digest '$d' is not sha256:<64 hex>"; done
command -v skopeo > /dev/null || fail "skopeo is required to load the candidate unchanged"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
cand="$(cd "$cand" && pwd)"
: > "$out/images.env"
emit() {
  printf '%s=%s\n' "$1" "$2" >> "$out/images.env"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi
}
top() { python3 -c 'import json,sys; m=json.load(open(sys.argv[1]))["manifests"]; assert len(m)==1 and (m[0].get("annotations") or {}).get("org.opencontainers.image.ref.name")=="gated", m; print(m[0]["digest"])' "$1/index.json"; }
emit revision "$(git rev-parse HEAD)"
short="$(git rev-parse --short=8 HEAD)"
for role in api worker; do
  layout="$cand/$role-layout"
  want="$want_api"
  [ "$role" = worker ] && want="$want_worker"
  have="$(top "$layout")" || fail "$layout is not a gated layout"
  [ "$have" = "$want" ] || fail "$role candidate index is $have, not the requested $want"
  image="crewflow-gate/$role:candidate-$short-$arch"
  if docker image inspect "$image" > /dev/null 2>&1; then fail "local image $image already exists"; fi
  skopeo copy --quiet --override-os linux --override-arch "$arch" "oci:$layout:gated" "docker-daemon:$image"
  emit "$role-image" "$image"
  emit "$role-id" "$(docker image inspect -f '{{.Id}}' "$image")"
  emit "$role-layout" "$layout"
  emit "$role-index" "$have"
done
cat "$out/images.env"
