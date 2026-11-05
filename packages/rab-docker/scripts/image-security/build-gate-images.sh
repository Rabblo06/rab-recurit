#!/usr/bin/env bash
# Docker hardening H5 (O1: one image): build THE Crewflow image (API + Worker, chosen by command) for ONE platform,
# exactly as the image gate then inspects and scans it. Nothing is pushed: the image is built ONCE into an OCI layout (with
# SBOM + provenance attestations), and that exact platform image is then loaded from the layout into the local Docker image
# store (skopeo docker-daemon:, or `docker load` of the layout with the containerd image store). BuildKit's `docker`
# exporter cannot carry attestations, so the image is never built a second time for loading; image_gate.py attest proves
# that the loaded image's identity and layer chain equal the layout's.
#
#   bash packages/rab-docker/scripts/image-security/build-gate-images.sh <linux/amd64|linux/arm64> <out-dir>
#
# Needs a BuildKit builder with OCI layout output (docker/setup-buildx-action's docker-container driver in CI) and skopeo
# (on GitHub's Ubuntu runners; the workflow installs it if missing). Always --pull --no-cache: a release never reuses a
# cached apk layer, and a PR build has no cache to reuse anyway. The BuildKit frontend and the SBOM generator are pinned by
# digest here (the Dockerfile's `# syntax=` line is overridden for these builds). Builds only committed source: a dirty or
# untracked working tree is refused.
#
# Writes <out-dir>/images.env and, in GitHub Actions, step outputs: image, image-id, image-layout, image-index, revision.
set -euo pipefail

FRONTEND='docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e'
SBOM_GENERATOR='docker/buildkit-syft-scanner:1.12.1@sha256:873a7458c3c8ac8e32c7b796c10e1600b07b963d2aa000a72a2d97aaaa2d6315'

fail() {
  echo "::error::build-gate-images: $*" >&2
  exit 1
}
platform="${1:-}"
out="${2:-}"
case "$platform" in linux/amd64 | linux/arm64) ;; *) fail "usage: build-gate-images.sh <linux/amd64|linux/arm64> <out-dir>" ;; esac
[ -n "$out" ] || fail "no output directory"
arch="${platform#linux/}"
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || fail "the working tree has uncommitted or untracked files; the gate builds committed source only"
rev="$(git rev-parse HEAD)"
short="${rev:0:8}"
source_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-Rabblo06/rab-recurit}"
repo_prefix="${IMAGE_REPO_PREFIX:-crewflow-gate}"
tag="${IMAGE_TAG_PREFIX:-gate}-${short}-${arch}"
image="${repo_prefix}/image:${tag}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
[ ! -e "$out/image-layout" ] || fail "$out/image-layout already exists"
if docker image inspect "$image" > /dev/null 2>&1; then fail "local image $image already exists; never overwrite a tag"; fi

emit() { # key value
  printf '%s=%s\n' "$1" "$2" >> "$out/images.env"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi
}
: > "$out/images.env"
emit revision "$rev"

load_layout() { # layout image-name: load the layout's linux/<arch> image into the Docker image store, unchanged
  if command -v skopeo > /dev/null 2>&1; then
    skopeo copy --quiet --override-os linux --override-arch "$arch" "oci:$1" "docker-daemon:$2"
  else
    # Docker with the containerd image store loads an OCI layout archive as is.
    local id
    id="$(tar -C "$1" -cf - . | docker load | sed -n 's/^Loaded image ID: //p; s/^Loaded image: //p' | tail -n 1)"
    [ -n "$id" ] || fail "docker load of $1 reported no image"
    docker tag "$id" "$2"
  fi
  docker image inspect "$2" > /dev/null || fail "$2 was not loaded"
}

index_digest() { # layout -> the digest of its single top-level entry
  python3 -c 'import json,sys; m=json.load(open(sys.argv[1]))["manifests"]; assert len(m)==1, m; print(m[0]["digest"])' \
    "$1/index.json"
}

echo "== The image ($platform, $rev): API + Worker, chosen by command"
docker buildx build --platform "$platform" --pull --no-cache --progress plain \
  --build-arg "BUILDKIT_SYNTAX=$FRONTEND" \
  --attest "type=sbom,generator=$SBOM_GENERATOR" \
  --attest "type=provenance,mode=max" \
  --label "org.opencontainers.image.revision=$rev" \
  --label "org.opencontainers.image.source=$source_url" \
  -f packages/rab-docker/rab/Dockerfile --target rab \
  --output "type=oci,tar=false,dest=$out/image-layout" \
  --metadata-file "$out/image-build-metadata.json" \
  .
load_layout "$out/image-layout" "$image"
emit image "$image"
emit image-id "$(docker image inspect -f '{{.Id}}' "$image")"
emit image-layout "$out/image-layout"
emit image-index "$(index_digest "$out/image-layout")"
cat "$out/images.env"
