#!/usr/bin/env bash
# Compares the built application inside two crewflow-cost image pairs, file by file (sha256), e.g. to prove that a
# tree-snapshot build of a clean worktree equals the commit-mode build of the same commit.
#   scripts/compare-images.sh <tagA> <tagB> <out dir>
# For each of server and worker: sha256 of every file under /app/packages/*/dist* (dist, dist-cjs, dist-esm), plus
# /opt/crewflow-bundle for the worker, plus the /app/node_modules file list hash and the image layer digests. Runs each
# image once with --network none and the harness label; reads only. Exit 0 = identical application files.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
A="${1:?usage: compare-images.sh <tagA> <tagB> <out dir>}"; B="${2:?tagB}"; D="${3:?out dir}"
assert_outside_main "the output directory" "$D"; mkdir -p "$D"
LIST='cd /app/packages && find . -path "./*/dist*" -type f -print0 | sort -z | xargs -0 sha256sum; [ -d /opt/crewflow-bundle ] && (cd /opt/crewflow-bundle && find . -type f -print0 | sort -z | xargs -0 sha256sum | sed "s#  \./#  /opt/crewflow-bundle/#"); echo "node_modules-file-list $(cd /app/node_modules && find . -type f | sort | sha256sum | cut -c1-64)"'
rc=0
: > "$D/compare-images.txt"
say() { echo "$*" | tee -a "$D/compare-images.txt"; }
for kind in server worker; do
  for t in "$A" "$B"; do
    docker image inspect "crewflow-cost/$kind:$t" >/dev/null 2>&1 || die "crewflow-cost/$kind:$t not found"
    docker run --rm --network none --label "$COST_HARNESS_LABEL=true" --user 0:0 --entrypoint sh "crewflow-cost/$kind:$t" -c "$LIST" > "$D/$kind-$t.sha256"
    docker image inspect -f '{{range .RootFS.Layers}}{{println .}}{{end}}' "crewflow-cost/$kind:$t" | grep . > "$D/$kind-$t.layers"
  done
  n="$(grep -c '  ./' "$D/$kind-$A.sha256" || true)"
  if cmp -s "$D/$kind-$A.sha256" "$D/$kind-$B.sha256"; then
    say "$kind: IDENTICAL application files ($n dist files + bundle + node_modules list) between :$A and :$B"
  else
    rc=1; say "$kind: DIFFERENT application files between :$A and :$B"; diff "$D/$kind-$A.sha256" "$D/$kind-$B.sha256" | head -40 | tee -a "$D/compare-images.txt"
  fi
  if cmp -s "$D/$kind-$A.layers" "$D/$kind-$B.layers"; then say "$kind: identical layer digests ($(wc -l < "$D/$kind-$A.layers") layers)"; else say "$kind: layer digests differ ($(diff "$D/$kind-$A.layers" "$D/$kind-$B.layers" | grep -c '^[<>]') lines)"; fi
  say "$kind: image ids $(docker image inspect -f '{{.Id}}' "crewflow-cost/$kind:$A" | cut -c1-19) / $(docker image inspect -f '{{.Id}}' "crewflow-cost/$kind:$B" | cut -c1-19)"
done
exit "$rc"
