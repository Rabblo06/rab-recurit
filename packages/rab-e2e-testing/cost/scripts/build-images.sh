#!/usr/bin/env bash
# Builds crewflow-cost/server:<tag> and crewflow-cost/worker:<tag>. Never touches rab-server:latest / rab-worker:latest.
#
#   scripts/build-images.sh <commit> [tag]
#       commit mode: build context = a CLEAN `git archive <commit>` (the working tree, uncommitted files and this harness
#       are never part of it). Tag defaults to the 8-char short sha.
#   scripts/build-images.sh --tree <worktree> [--tag-file <file>] [--meta-out <file>]
#       tree-snapshot mode (scripts/tree-snapshot.sh): build context = the worktree's CURRENT files (tracked as on disk +
#       untracked-not-ignored), with NO commit/stash/tag/index change in any repo. Tag = tree-<sha256[0:12]> of the
#       content manifest. If both images with that tag already exist (labelled with the same tree hash) they are reused
#       (COST_REBUILD=1 forces a build). The meta file (base commit, tree hash, file-list hash, git status) is kept at
#       $COST_WORK/build/meta/<tag>.meta (+ .manifest, .list, .deleted) and copied to --meta-out; the tag is written to
#       --tag-file. The main checkout is refused.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"

build_pair() { # <context dir> <tag> <label args...>
  local wctx; wctx="$(hostpath "$1")"; local tag="$2"; shift 2
  log "building crewflow-cost/server:$tag"
  docker build --progress=plain --target rab "$@" \
    -f "$wctx/packages/rab-docker/rab/Dockerfile" -t "crewflow-cost/server:$tag" "$wctx"
  log "building crewflow-cost/worker:$tag"
  docker build --progress=plain \
    --build-arg "CREWFLOW_BASE_IMAGE=crewflow-cost/server:$tag" "$@" \
    -f "$wctx/packages/rab-docker/rab/Dockerfile.worker-bundle" -t "crewflow-cost/worker:$tag" "$wctx"
  docker image inspect "crewflow-cost/server:$tag" "crewflow-cost/worker:$tag" --format '{{index .RepoTags 0}} {{.Id}} {{.Created}}'
}

if [ "${1:-}" = "--tree" ]; then
  TREE="${2:?usage: build-images.sh --tree <worktree> [--tag-file <file>] [--meta-out <file>]}"; shift 2
  TAG_FILE=""; META_OUT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag-file) TAG_FILE="$2"; shift 2 ;;
      --meta-out) META_OUT="$2"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  SNAP="$COST_WORK/build/tree-snap-$$"
  TMPMETA="$COST_WORK/build/tree-snap-$$.meta"
  trap 'rm -rf "$SNAP" "$TMPMETA" "$TMPMETA".*' EXIT
  COST_TAG="$(bash "$HERE/tree-snapshot.sh" "$TREE" "$SNAP" "$TMPMETA")"; require_tag
  TREE_HASH="$(sed -n 's/^treeHash=//p' "$TMPMETA")"
  BASE="$(sed -n 's/^baseCommit=//p' "$TMPMETA")"
  LIST_HASH="$(sed -n 's/^fileListHash=//p' "$TMPMETA")"
  MDIR="$COST_WORK/build/meta"; mkdir -p "$MDIR"
  for s in "" .manifest .list .deleted; do cp "$TMPMETA$s" "$MDIR/$COST_TAG.meta$s"; done
  [ -z "$META_OUT" ] || { assert_outside_main "--meta-out" "$META_OUT"; mkdir -p "$(dirname "$META_OUT")"; cp "$TMPMETA" "$META_OUT"; }
  [ -z "$TAG_FILE" ] || { assert_outside_main "--tag-file" "$TAG_FILE"; mkdir -p "$(dirname "$TAG_FILE")"; echo "$COST_TAG" > "$TAG_FILE"; }
  have() { [ "$(docker image inspect -f '{{index .Config.Labels "crewflow-cost.tree-hash"}}' "crewflow-cost/$1:$COST_TAG" 2>/dev/null)" = "$TREE_HASH" ]; }
  if have server && have worker && [ "${COST_REBUILD:-0}" != 1 ]; then
    log "reusing crewflow-cost/{server,worker}:$COST_TAG (labels carry the same tree hash)"
  else
    build_pair "$SNAP" "$COST_TAG" \
      --label "crewflow-cost.source=tree" --label "crewflow-cost.tree-hash=$TREE_HASH" \
      --label "crewflow-cost.file-list-hash=$LIST_HASH" --label "crewflow-cost.base-commit=$BASE" \
      --label "crewflow-cost.tree-path=$(sed -n 's/^tree=//p' "$TMPMETA")"
  fi
  log "done (tree mode, tag $COST_TAG, base $BASE; meta $MDIR/$COST_TAG.meta)"
  exit 0
fi

COMMIT_ARG="${1:?usage: build-images.sh <commit> [tag] | --tree <worktree>}"
FULL="$(GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$REPO")" rev-parse "${COMMIT_ARG}^{commit}")"
COST_TAG="${2:-${FULL:0:8}}"; require_tag
case "$COST_TAG" in tree-*) die "the tree-* tag namespace is reserved for --tree builds" ;; esac
CTX="$COST_WORK/build/${FULL:0:8}"
rm -rf "$CTX"; mkdir -p "$CTX"
log "archiving $FULL into $CTX"
GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$REPO")" -c core.autocrlf=false archive --format=tar "$FULL" | tar -x -C "$CTX"
build_pair "$CTX" "$COST_TAG" --label "crewflow-cost.commit=$FULL"
rm -rf "$CTX"
log "done"
