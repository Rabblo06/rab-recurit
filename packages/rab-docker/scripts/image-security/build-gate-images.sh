#!/usr/bin/env bash
# Docker hardening H5: build the API image and the Worker bundle image FROM it, for ONE platform, exactly as the image
# gate then inspects and scans them. Nothing is pushed: each image is built ONCE into an OCI layout (with SBOM +
# provenance attestations), and that exact platform image is then loaded from the layout into the local Docker image
# store (skopeo docker-daemon:, or `docker load` of the layout with the containerd image store). BuildKit's `docker`
# exporter cannot carry attestations, so the image is never built a second time for loading; image_gate.py attest proves
# that the loaded image's identity and layer chain equal the layout's.
#
#   bash packages/rab-docker/scripts/image-security/build-gate-images.sh <linux/amd64|linux/arm64> <out-dir>
#
# Needs a BuildKit builder with OCI layout output and oci-layout build contexts (docker/setup-buildx-action's
# docker-container driver in CI) and skopeo (on GitHub's Ubuntu runners; the workflow installs it if missing). Always --pull --no-cache: a release never reuses a cached apk layer, and a PR build
# has no cache to reuse anyway. The Worker is built FROM the API layout by digest (named build context), never from a
# tag. The BuildKit frontend and the SBOM generator are pinned by digest here (the Dockerfiles' `# syntax=` line is
# overridden for these builds; see the H5 report for the Dockerfile change). Builds only committed source: a dirty or
# untracked working tree is refused.
#
# Writes <out-dir>/images.env and, in GitHub Actions, step outputs: api-image, api-id, api-layout, worker-image,
# worker-id, worker-layout, revision. The API outputs are written as soon as the API image exists, so the API gates
# still run when the Worker build fails (and the Worker checks then report NOT RUN = FAIL).
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
api_image="${repo_prefix}/api:${tag}"
worker_image="${repo_prefix}/worker:${tag}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
for d in "$out/api-layout" "$out/worker-layout"; do [ ! -e "$d" ] || fail "$d already exists"; done
for i in "$api_image" "$worker_image"; do
  if docker image inspect "$i" > /dev/null 2>&1; then fail "local image $i already exists; never overwrite a tag"; fi
done

emit() { # key value
  printf '%s=%s\n' "$1" "$2" >> "$out/images.env"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi
}
: > "$out/images.env"
emit revision "$rev"

common=(
  --platform "$platform" --pull --no-cache --progress plain
  --build-arg "BUILDKIT_SYNTAX=$FRONTEND"
  --attest "type=sbom,generator=$SBOM_GENERATOR"
  --attest "type=provenance,mode=max"
  --label "org.opencontainers.image.revision=$rev"
  --label "org.opencontainers.image.source=$source_url"
)

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

echo "== API image ($platform, $rev)"
docker buildx build "${common[@]}" \
  -f packages/rab-docker/rab/Dockerfile --target rab \
  --output "type=oci,tar=false,dest=$out/api-layout" \
  --metadata-file "$out/api-build-metadata.json" \
  .
api_index="$(index_digest "$out/api-layout")"
load_layout "$out/api-layout" "$api_image"
emit api-image "$api_image"
emit api-id "$(docker image inspect -f '{{.Id}}' "$api_image")"
emit api-layout "$out/api-layout"
emit api-index "$api_index"

echo "== Worker bundle image FROM the API layout $api_index"
docker buildx build "${common[@]}" \
  -f packages/rab-docker/rab/Dockerfile.worker-bundle \
  --build-arg CREWFLOW_BASE_IMAGE=crewflow-gate-api-base \
  --build-context "crewflow-gate-api-base=oci-layout://$out/api-layout@$api_index" \
  --output "type=oci,tar=false,dest=$out/worker-layout" \
  --metadata-file "$out/worker-build-metadata.json" \
  .
load_layout "$out/worker-layout" "$worker_image"
emit worker-image "$worker_image"
emit worker-id "$(docker image inspect -f '{{.Id}}' "$worker_image")"
emit worker-layout "$out/worker-layout"
emit worker-index "$(index_digest "$out/worker-layout")"
cat "$out/images.env"
