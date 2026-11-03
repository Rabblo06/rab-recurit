#!/usr/bin/env bash
# Docker hardening H5: run every image gate for one role (api | worker) against the image build-gate-images.sh produced.
# Each check runs even if an earlier one failed (they are independent; `vulns` reads what `fs` and `scan` wrote, and
# reports a failure of its own if those are missing). Exit 1 if any check FAILED. In MODE=pr, release-only findings
# (HOLD) do not fail; in MODE=release (the default) they do.
#
#   MODE=pr|release RESULTS=<dir> PLATFORM=linux/<arch> REVISION=<sha> IMAGE=<ref> IMAGE_ID=<sha256:..> LAYOUT=<dir> \
#   TRIVY_CACHE=<dir|volume> GRYPE_CACHE=<dir|volume> [SOURCE_URL=<url>] \
#     bash packages/rab-docker/scripts/image-security/run-role-gates.sh <api|worker>
set -uo pipefail
role="${1:-}"
case "$role" in api | worker) ;; *) echo "::error::usage: run-role-gates.sh <api|worker>" >&2; exit 2 ;; esac
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
# Mandatory native PDF render (Worker only): a real report through the production renderer, as the launcher's jobs child.
if [ "$role" = worker ]; then run pdf pdf "$role" "$IMAGE"; fi
if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::$role image gates FAILED: ${failed[*]}"
  exit 1
fi
echo "$role image gates: no failure (see the summary for HOLD items)"
