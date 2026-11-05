#!/usr/bin/env bash
# Docker hardening H5 (O1: one image): run every image gate against the image build-gate-images.sh (or load-candidate.sh)
# produced. ONE role, `image` (policy.json roles.image: the merge of the former api and worker roles). Each check runs even
# if an earlier one failed (they are independent; `vulns` reads what `fs` and `scan` wrote, and reports a failure of its
# own if those are missing). Exit 1 if any check FAILED. In MODE=pr, release-only findings (HOLD) do not fail; in
# MODE=release (the default) they do.
#
#   MODE=pr|release RESULTS=<dir> PLATFORM=linux/<arch> REVISION=<sha> IMAGE=<ref> IMAGE_ID=<sha256:..> LAYOUT=<dir> \
#   TRIVY_CACHE=<dir|volume> GRYPE_CACHE=<dir|volume> [SOURCE_URL=<url>] \
#     bash packages/rab-docker/scripts/image-security/run-role-gates.sh image
set -uo pipefail
role="${1:-}"
case "$role" in image) ;; *) echo "::error::usage: run-role-gates.sh image" >&2; exit 2 ;; esac
for v in RESULTS PLATFORM REVISION IMAGE IMAGE_ID LAYOUT TRIVY_CACHE GRYPE_CACHE; do
  [ -n "${!v:-}" ] || { echo "::error::run-role-gates.sh: $v is not set" >&2; exit 2; }
done
gate=(python3 "$(dirname "$0")/image_gate.py" --mode "${MODE:-release}" --results "$RESULTS")
source_args=()
[ -z "${SOURCE_URL:-}" ] || source_args=(--source "$SOURCE_URL")
failed=()
run() { # name, then the image_gate.py command
  local name="$1"
  shift
  echo "::group::$role $name"
  if ! "${gate[@]}" "$@"; then failed+=("$name"); fi
  echo "::endgroup::"
}
run config config "$role" "$IMAGE" --revision "$REVISION" --platform "$PLATFORM" "${source_args[@]}"
run container container "$role" "$IMAGE"
run fs fs "$role" "$IMAGE"
run attest attest "$role" "$LAYOUT" --image "$IMAGE" --image-id "$IMAGE_ID" --revision "$REVISION" --platform "$PLATFORM"
run scan scan "$role" "$IMAGE" --image-id "$IMAGE_ID" --trivy-cache "$TRIVY_CACHE" --grype-cache "$GRYPE_CACHE"
run vulns vulns "$role"
run secrets secrets "$role"
# Mandatory native PDF render: a real report through the production renderer, as the Worker runs it (uid 1000, its jobs
# environment and tmpfs mounts), on a native host.
run pdf pdf "$role" "$IMAGE"
if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::$role gates FAILED: ${failed[*]}"
  exit 1
fi
echo "$role gates: no failure (see the summary for HOLD items)"
