#!/usr/bin/env bash
# cd-deploy-tag: creates the GitHub release record for a pushed version tag with the preinstalled gh CLI (replaces
# softprops/action-gh-release: one less third-party action holding a contents:write token).
#
# Env:  TAG                 the pushed tag (github.ref_name), vMAJOR.MINOR.PATCH[suffix]
#       GITHUB_REPOSITORY   owner/repo
#       GITHUB_SHA          the tagged commit (names the one release image)
#       GH_TOKEN            contents:write (gh reads it)
#       DRY_RUN=1           print the gh command line and the notes; call nothing (no token needed)
#
# Same release as before: title = the tag, our notes first, then GitHub's generated notes, not a draft, not a prerelease.
# Differences, both fail-closed: --verify-tag refuses to create a tag that does not already exist on GitHub, and an
# existing release for the tag is an error (softprops silently updated it).
set -euo pipefail

: "${TAG:?TAG is required}" "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" "${GITHUB_SHA:?GITHUB_SHA is required}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*$ ]] || { echo "::error::not a version tag: $TAG"; exit 1; }
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::GITHUB_SHA is not a commit SHA: $GITHUB_SHA"; exit 1; }
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "::error::bad GITHUB_REPOSITORY: $GITHUB_REPOSITORY"; exit 1; }

notes="$(mktemp)"
trap 'rm -f "$notes"' EXIT
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

args=(release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --title "$TAG" --generate-notes --notes-file "$notes")

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "dry run: gh ${args[*]}"
  printf '%s\n' '--- notes ---'
  cat "$notes"
  exit 0
fi

gh "${args[@]}"
