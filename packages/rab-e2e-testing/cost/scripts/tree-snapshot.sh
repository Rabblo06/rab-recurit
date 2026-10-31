#!/usr/bin/env bash
# Tree-snapshot build context: copies a git worktree's CURRENT files into a build context directory WITHOUT creating
# a commit, stash, tag, ref or index change in any repository. Used by `build-images.sh --tree` / `run.sh --tree` to
# measure uncommitted work (e.g. an integration worktree the owner has not authorised to commit).
#
#   scripts/tree-snapshot.sh <worktree> <context dir> <meta file>      prints the image tag `tree-<sha256[0:12]>`
#
# What is copied: `git ls-files -co --exclude-standard` = tracked files (as they are on disk, i.e. including
# uncommitted modifications) + untracked files that are not ignored. Tracked files deleted on disk are left out (and
# listed in the meta file). Ignored files (node_modules, dist, .env, ...) are never copied. This is exactly what a
# commit of the tree would contain (`git add -A && git commit`), without making one.
#
# Read-only on the repository, enforced and verified:
#   - every git call runs with GIT_OPTIONAL_LOCKS=0 (no index refresh, no lock files) and is a read command
#     (rev-parse, ls-files, status, for-each-ref, symbolic-ref);
#   - the worktree's index file, HEAD, every ref (refs/stash included) and packed-refs are hashed before and after the
#     snapshot; any difference aborts (exit 1) and the build does not run;
#   - the main checkout ($COST_MAIN_CHECKOUT, default C:/Rab-recruit) is refused, by path and by git toplevel.
#
# Content identity: <tree hash> = sha256 of the manifest "<sha256(content)>  <path>" (one line per copied file,
# LC_ALL=C path order), computed from the COPIED context, i.e. from exactly the bytes the image is built from.
# <file-list hash> = sha256 of the NUL-separated sorted path list. Both go into the meta file and the image labels.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
TREE_ARG="${1:?usage: tree-snapshot.sh <worktree> <context dir> <meta file>}"
CTX="${2:?context dir}"
META="${3:?meta file}"

[ -d "$TREE_ARG" ] || die "tree-snapshot: $TREE_ARG is not a directory"
TREE="$(cd "$TREE_ARG" && pwd)"
assert_outside_main "the tree to snapshot (--tree)" "$TREE"
[ "$(norm_path "$TREE")" != "$(norm_path "$COST_MAIN_CHECKOUT")" ] || die "tree-snapshot: refusing the main checkout $COST_MAIN_CHECKOUT"
assert_outside_main "the snapshot context dir" "$CTX"
assert_outside_main "the snapshot meta file" "$META"

tgit() { GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$TREE")" -c core.quotepath=false "$@"; }
tgit rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "tree-snapshot: $TREE is not a git work tree"
TOP="$(tgit rev-parse --show-toplevel)"
[ "$(norm_path "$TOP")" = "$(norm_path "$TREE")" ] || die "tree-snapshot: $TREE is not the top of its work tree ($TOP); pass the worktree root"
path_is_under "$TOP" "$COST_MAIN_CHECKOUT" && die "tree-snapshot: git toplevel $TOP is the main checkout; refusing"
GITDIR="$(tgit rev-parse --absolute-git-dir)"
COMMONDIR="$(cd "$(tgit rev-parse --path-format=absolute --git-common-dir)" && pwd)"

# Digest of everything a write would change: the worktree's index, its HEAD, every ref (incl. refs/stash), packed-refs.
git_state() {
  {
    echo "HEAD $(tgit rev-parse HEAD)"
    echo "SYMREF $(tgit symbolic-ref -q HEAD || echo detached)"
    if [ -f "$GITDIR/index" ]; then echo "INDEX $(sha256sum < "$GITDIR/index" | cut -c1-64) $(wc -c < "$GITDIR/index" | tr -d ' ')"; else echo "INDEX none"; fi
    tgit for-each-ref --format='%(refname) %(objectname)' | sha256sum | sed 's/ .*//; s/^/REFS /'
    if [ -f "$COMMONDIR/packed-refs" ]; then echo "PACKED $(sha256sum < "$COMMONDIR/packed-refs" | cut -c1-64)"; else echo "PACKED none"; fi
    echo "STASH $(tgit rev-parse -q --verify refs/stash || echo none)"
  }
}
BEFORE="$(git_state)"

rm -rf "$CTX"; mkdir -p "$CTX" "$(dirname "$META")"
LIST="$META.list"; DELETED="$META.deleted"
: > "$LIST"; : > "$DELETED"
n=0; nd=0
while IFS= read -r -d '' p; do
  if [ -f "$TREE/$p" ] || [ -L "$TREE/$p" ]; then printf '%s\0' "$p" >> "$LIST"; n=$((n + 1))
  else printf '%s\n' "$p" >> "$DELETED"; nd=$((nd + 1)); fi
done < <(tgit ls-files -z -co --exclude-standard | LC_ALL=C sort -zu)
[ "$n" -gt 0 ] || die "tree-snapshot: no files listed in $TREE"
( cd "$TREE" && tar --null -T "$LIST" -cf - ) | tar -xf - -C "$CTX"

# Manifest from the COPIED context (the bytes docker build receives).
MANIFEST="$META.manifest"
( cd "$CTX" && tr '\0' '\n' < "$LIST" | while IFS= read -r p; do
    if [ -L "$p" ]; then printf '%s  %s\n' "symlink:$(readlink "$p")" "$p"; fi
  done ) > "$MANIFEST.links"
( cd "$CTX" && xargs -0 sha256sum -b -- < "$LIST" ) | sed 's/ \*/  /' > "$MANIFEST.files"
cat "$MANIFEST.files" "$MANIFEST.links" | LC_ALL=C sort -k2 > "$MANIFEST"
rm -f "$MANIFEST.files" "$MANIFEST.links"
copied="$(find "$CTX" -type f -o -type l | wc -l | tr -d ' ')"
[ "$copied" = "$n" ] || die "tree-snapshot: listed $n files but the context holds $copied"
TREE_HASH="$(sha256sum < "$MANIFEST" | cut -c1-64)"
LIST_HASH="$(sha256sum < "$LIST" | cut -c1-64)"
TAG="tree-${TREE_HASH:0:12}"

AFTER="$(git_state)"
if [ "$BEFORE" != "$AFTER" ]; then
  echo "[cost] tree-snapshot: repository state changed during the snapshot (index/HEAD/refs). Before vs after:" >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  die "tree-snapshot: aborting; the snapshot is not trustworthy"
fi

STATUS="$(tgit status --porcelain=v1 -uall)"
{
  echo "source=tree"
  echo "tag=$TAG"
  echo "tree=$(norm_path "$TREE")"
  echo "baseCommit=$(tgit rev-parse HEAD)"
  echo "branch=$(tgit symbolic-ref -q --short HEAD || echo detached)"
  echo "treeHash=$TREE_HASH"
  echo "fileListHash=$LIST_HASH"
  echo "files=$n"
  echo "deletedTrackedFilesExcluded=$nd"
  echo "statusLines=$(printf '%s' "$STATUS" | grep -c . || true)"
  echo "modifiedTracked=$(printf '%s\n' "$STATUS" | grep -cE '^( M|M |MM|A |AM| T|R )' || true)"
  echo "untrackedIncluded=$(printf '%s\n' "$STATUS" | grep -c '^?? ' || true)"
  echo "snapshotAt=$(date -u +%FT%TZ)"
  echo "gitStateBefore=$(echo "$BEFORE" | sha256sum | cut -c1-16) gitStateAfter=$(echo "$AFTER" | sha256sum | cut -c1-16) (index, HEAD, refs, packed-refs, stash; must be equal)"
  echo "## git status --porcelain=v1 -uall (read with GIT_OPTIONAL_LOCKS=0)"
  printf '%s\n' "$STATUS"
} > "$META"
log "tree snapshot $TAG: $n files ($nd deleted tracked excluded), base $(tgit rev-parse --short=8 HEAD), $(printf '%s' "$STATUS" | grep -c . || true) status line(s); repo state unchanged"
echo "$TAG"
