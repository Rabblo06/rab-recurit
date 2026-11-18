#!/usr/bin/env bash
# cd-deploy-tag: the GitHub release record for a pushed rab/vX.Y.Z tag, with the preinstalled gh CLI.
#
# Releases are cut on rab/vX.Y.Z tags (rab/v0.3.0 .. rab/v0.6.0), the only tags publish-image's release guard accepts
# (release_guard.py RELEASE_TAG, the `release` environment's rab/v* tag policy). A tag arrives one of two ways:
#
#   1. The owner publishes a release in GitHub (UI or `gh release create` with their own login), which creates the tag.
#      The release already exists here: this script changes nothing and says so. publish-image already started from
#      that `release: published` event (a person's event, so it triggers workflows).
#   2. Someone pushes the tag with git. This script creates a DRAFT release with our notes. It does not publish it: a
#      release published with the workflow's GITHUB_TOKEN triggers no workflow, so publish-image would never run. The
#      owner reviews the draft and clicks "Publish release"; that is their event, publish-image runs on the tag, and the
#      `release` environment approval follows.
#
# Env:  TAG                 the pushed tag (github.ref_name), rab/vMAJOR.MINOR.PATCH[-prerelease]
#       GITHUB_REPOSITORY   owner/repo
#       GITHUB_SHA          the tagged commit (names the one release image)
#       GH_TOKEN            contents:write (gh reads it)
#       GITHUB_STEP_SUMMARY optional; the outcome and the next step are appended to it
#       DRY_RUN=1           print the gh command lines and the notes; call nothing (no token needed)
#
# Fail-closed: --verify-tag refuses to create a tag that does not already exist on GitHub, a lookup error other than
# "release not found" stops the job, and a release created between the lookup and the create makes `gh release create`
# fail rather than overwrite anything.
set -euo pipefail

: "${TAG:?TAG is required}" "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" "${GITHUB_SHA:?GITHUB_SHA is required}"
# Same pattern as release_guard.py RELEASE_TAG: a tag this script accepts is one publish-image will publish.
[[ "$TAG" =~ ^rab/v([0-9]+\.[0-9]+\.[0-9]+)(-[0-9A-Za-z.-]+)?$ ]] || { echo "::error::not a rab/vX.Y.Z release tag: $TAG"; exit 1; }
version="v${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
prerelease="${BASH_REMATCH[2]}"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::GITHUB_SHA is not a commit SHA: $GITHUB_SHA"; exit 1; }
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "::error::bad GITHUB_REPOSITORY: $GITHUB_REPOSITORY"; exit 1; }

summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi; }

notes="$(mktemp)"
err="$(mktemp)"
trap 'rm -f "$notes" "$err"' EXIT
{
  printf 'Release image (API + Worker, one image): `docker.io/adhin007/adolphus:%s`, published by\n' "$GITHUB_SHA"
  cat <<'EOF'
`publish-image` under this single commit tag. Deploy by the index digest in that run's `release-manifest`,
never by tag: set `CREWFLOW_IMAGE_TAG=sha256:<index digest>` in `compose.env`.

Take a provider snapshot/restore point first. Deploy the API and Worker together, from the same image tag,
with `docker compose pull && docker compose up -d`. The API starts first and migrates; the Worker starts
when the API is healthy. Never update the API alone while an older Worker keeps running.
Rollback: `CREWFLOW_IMAGE_TAG=<previous digest>`, then the same command; both go back together.
EOF
} > "$notes"

view=(release view "$TAG" --repo "$GITHUB_REPOSITORY" --json isDraft,url --jq '"\(.isDraft) \(.url)"')
# Title as the published releases have it ("Crewflow v0.6.0"); the owner can edit it on the draft.
create=(release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --draft --title "Crewflow $version"
  --generate-notes --notes-file "$notes")
if [ -n "$prerelease" ]; then create+=(--prerelease); fi

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "dry run: gh ${view[*]}"
  echo "dry run: gh ${create[*]}"
  printf '%s\n' '--- notes ---'
  cat "$notes"
  exit 0
fi

if existing="$(gh "${view[@]}" 2> "$err")"; then
  read -r is_draft url <<< "$existing"
  state=published
  [ "$is_draft" = true ] && state=draft
  echo "a $state release for $TAG already exists ($url); nothing to do"
  summary "### $TAG: a $state release already exists" "" "$url. Nothing was changed." "" \
    "- published by a person: \`publish-image\` already started from its \`release: published\` event; approve the" \
    "  \`release\` environment there." \
    "- a draft: publish it by hand (Releases -> Edit -> Publish release), which starts \`publish-image\`."
  exit 0
fi
if ! grep -qx 'release not found' "$err"; then
  echo "::error::could not tell whether a release for $TAG exists: $(tr '\n' ' ' < "$err")"
  exit 1
fi

gh "${create[@]}"
echo "draft release created for $TAG; publish it by hand to start publish-image"
summary "### $TAG: draft release created" "" \
  "Nothing is published yet, and \`publish-image\` has NOT started: a release published with this workflow's" \
  "\`GITHUB_TOKEN\` would trigger no workflow, so this job only drafts it." "" \
  "Next, the owner: Releases -> the \`$TAG\` draft -> review the notes -> **Publish release**. That event starts" \
  "\`publish-image\` on the tag (gate on amd64 + arm64); then approve the \`release\` environment to push the image." \
  "If this commit's image was already published by a \`publish-image\` dispatch from \`main\`, reject that approval" \
  "instead (the push would refuse the existing \`<commit>\` tag anyway) and deploy the digest from that earlier run."
