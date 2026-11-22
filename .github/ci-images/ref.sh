#!/usr/bin/env bash
# Prints the digest-pinned reference of one CI image: bash .github/ci-images/ref.sh <name>   (e.g. postgres-16, redis)
# The reference lives in .github/ci-images/<name>/image.yaml as `image: <repo>:<tag>@sha256:<64 hex>`, where Dependabot's
# docker ecosystem can renew it. Anything else (no file, no digest, no tag, more than one image) fails: a `docker run` of a
# mutable tag must not happen silently.
set -euo pipefail
name="${1:-}"
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "::error::ci-images/ref.sh: bad image name '${name}'" >&2; exit 1; }
f="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${name}/image.yaml"
[ -f "$f" ] || { echo "::error::ci-images/ref.sh: no CI image '${name}' (${f})" >&2; exit 1; }
ref="$(sed -n -E 's/^image:[[:space:]]*([^[:space:]#]+)[[:space:]]*$/\1/p' "$f")"
if ! [[ "$ref" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::ci-images/ref.sh: ${f} must hold exactly one 'image: <repo>:<tag>@sha256:<64 hex>' line" >&2
  exit 1
fi
printf '%s\n' "$ref"
