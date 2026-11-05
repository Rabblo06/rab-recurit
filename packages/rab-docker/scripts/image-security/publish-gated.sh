#!/usr/bin/env bash
# Docker hardening H5: push ONE gated multi-platform OCI index to Docker Hub, exactly as gated (digests preserved; no
# rebuild), under ONE immutable tag, and prove the registry serves the same digests. Used by publish-image.yaml only.
#
#   publish-gated.sh <oci-layout-dir> <expected-index-digest> <tag>
#
# Environment:
#   REGISTRY_REPO          default docker.io/adhin007/adolphus
#   COMMIT                 full 40-hex source commit; the tag must be exactly <COMMIT> (O2: one image, one tag)
#   DOCKERHUB_USERNAME     from vars.DOCKERHUB_USERNAME     } both required; absent or empty = fail closed
#   DOCKERHUB_PUSH_TOKEN   from secrets.DOCKERHUB_PUSH_TOKEN } (never printed)
#   DRY_RUN=1              verify the layout, the tag and the credentials' presence, print the plan; no registry call
#   SKOPEO                 registry client (default: skopeo). Self-tests point it at a fake to prove the fail-closed paths
#                          without any network or real push.
#
# Fails closed when: a credential is missing; the tag is not exactly <COMMIT>; the layout's index is not the expected
# digest or any blob does not match its digest; the tag ALREADY EXISTS in the registry (any digest: tags are never
# overwritten); the registry's answer to the existence check is anything but "not found"; after the push the tag, the
# index digest or any per-platform manifest is not served with exactly the gated digest.
set -euo pipefail
fail() {
  echo "::error::publish-gated: $*" >&2
  exit 1
}
layout="${1:-}"
want="${2:-}"
tag="${3:-}"
repo="${REGISTRY_REPO:-docker.io/adhin007/adolphus}"
skopeo="${SKOPEO:-skopeo}"
[ -n "$layout" ] && [ -n "$want" ] && [ -n "$tag" ] || fail "usage: publish-gated.sh <oci-layout-dir> <expected-index-digest> <tag>"

# 1. Credentials: referenced by name only, created by the owner (environment `release`). Checked first, so a missing
#    secret can never fall through to an anonymous or partial push.
if [ -z "${DOCKERHUB_USERNAME:-}" ] || [ -z "${DOCKERHUB_PUSH_TOKEN:-}" ]; then
  fail "Docker Hub credentials are missing: the owner must create the repository variable/environment variable DOCKERHUB_USERNAME and the secret DOCKERHUB_PUSH_TOKEN in the protected GitHub environment 'release' (see packages/rab-docker/docs/IMAGE_SECURITY_RELEASE_POLICY.md section 9). Nothing was pushed."
fi

# 2. Tag policy (O2): exactly the full 40-hex commit, one tag per release; no `latest`, no prefix, no moving tags.
[[ "${COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || fail "COMMIT must be the full 40-hex source commit (got '${COMMIT:-}')"
[[ "$tag" == "$COMMIT" ]] || fail "tag '$tag' is not ${COMMIT}; only the one immutable full-commit tag is allowed"
[[ "$want" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "expected digest '$want' is not sha256:<64 hex>"

# 3. The layout is exactly the gated index, and every blob is intact.
python3 - "$layout" "$want" << 'EOF' || fail "the layout is not the gated index $want (see above); nothing was pushed"
import hashlib, json, os, sys
layout, want = sys.argv[1], sys.argv[2]
top = json.load(open(os.path.join(layout, 'index.json')))['manifests']
if len(top) != 1 or top[0]['digest'] != want:
    sys.exit(f'layout index {[m["digest"] for m in top]} != gated {want}')
if (top[0].get('annotations') or {}).get('org.opencontainers.image.ref.name') != 'gated':
    sys.exit('layout entry is not named "gated"')
bad = []
d = os.path.join(layout, 'blobs', 'sha256')
for name in os.listdir(d):
    h = hashlib.sha256()
    with open(os.path.join(d, name), 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    if h.hexdigest() != name:
        bad.append(name)
if bad:
    sys.exit(f'corrupt blobs: {bad}')
print(f'layout verified: {want}')
EOF
children="$(python3 -c 'import json,os,sys; L=sys.argv[1]; d=json.load(open(os.path.join(L,"index.json")))["manifests"][0]["digest"]; i=json.load(open(os.path.join(L,"blobs","sha256",d[7:]))); print(" ".join(m["digest"] for m in i["manifests"]))' "$layout")"
[ -n "$children" ] || fail "the gated index lists no manifests"

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "DRY RUN: would check that $repo:$tag does not exist, push $want (children: $children) with digests preserved, and verify the registry serves them. No registry call made."
  exit 0
fi

authdir="$(mktemp -d)"
auth="$authdir/auth.json"
cleanup() {
  "$skopeo" logout --authfile "$auth" docker.io > /dev/null 2>&1 || true
  rm -rf "$authdir"
}
trap cleanup EXIT
printf '%s' "$DOCKERHUB_PUSH_TOKEN" | "$skopeo" login --authfile "$auth" --username "$DOCKERHUB_USERNAME" --password-stdin docker.io > /dev/null \
  || fail "docker.io login failed for $DOCKERHUB_USERNAME (token wrong, expired or without Read & Write)"

# 4. Never overwrite: the tag must not exist in any form.
err="$authdir/inspect.err"
if "$skopeo" inspect --authfile "$auth" --raw "docker://$repo:$tag" > /dev/null 2> "$err"; then
  fail "$repo:$tag already exists; immutable tags are never overwritten (nothing was pushed)"
elif grep -qiE 'manifest unknown|not found|name unknown' "$err"; then
  echo "$repo:$tag does not exist yet"
else
  fail "cannot tell whether $repo:$tag exists: $(tail -c 300 "$err")"
fi

# 5. Push exactly the gated index.
"$skopeo" copy --authfile "$auth" --all --preserve-digests --retry-times 3 "oci:$layout:gated" "docker://$repo:$tag"

# 6. The registry must serve exactly the gated digests: the tag, the index by digest, and every child manifest.
served() { "$skopeo" inspect --authfile "$auth" --raw "$1" | python3 -c 'import hashlib,sys; print("sha256:" + hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'; }
have="$(served "docker://$repo:$tag")" || fail "cannot read back $repo:$tag"
[ "$have" = "$want" ] || fail "$repo:$tag serves $have, not the gated $want"
have="$(served "docker://$repo@$want")" || fail "cannot read back $repo@$want"
[ "$have" = "$want" ] || fail "$repo@$want serves $have"
for c in $children; do
  have="$(served "docker://$repo@$c")" || fail "cannot read back $repo@$c"
  [ "$have" = "$c" ] || fail "$repo@$c serves $have"
done
echo "published $repo:$tag = $want (children verified: $children)"
