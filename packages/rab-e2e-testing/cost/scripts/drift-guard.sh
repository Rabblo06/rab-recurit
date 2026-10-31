#!/usr/bin/env bash
# Main-checkout drift guard, standalone (run.sh uses the same functions from lib/guard.sh at every checkpoint).
#
#   COST_MAIN_CHECKOUT=<git work tree> bash scripts/drift-guard.sh snapshot <dir>
#   COST_MAIN_CHECKOUT=<git work tree> bash scripts/drift-guard.sh check <dir> <phase>
#
# snapshot  records HEAD + branch, `git status --porcelain=v1 -uall`, and size + sha256 of yarn.lock, .yarnrc.yml,
#           every package.json (tracked and untracked-not-ignored) and every path the status lists, into <dir>/baseline.
# check     re-snapshots and compares. Exit 0 = unchanged. Exit 3 = changed: the changed paths are printed and written
#           to <dir>/main-checkout-drift-<phase>.txt (and <dir>/MAIN-CHECKOUT-DRIFT.txt).
# Read-only on the checked tree: git runs with GIT_OPTIONAL_LOCKS=0, so even the index stat cache is not refreshed.
# COST_MAIN_CHECKOUT defaults to C:/Rab-recruit.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
cmd="${1:?usage: drift-guard.sh snapshot|check <dir> [phase]}"
dir="${2:?dir}"
assert_outside_main "the drift-guard directory" "$dir"
case "$cmd" in
  snapshot)
    rm -rf "$dir/baseline"; mkdir -p "$dir"
    drift_snapshot "$dir/baseline"
    log "baseline of $COST_MAIN_CHECKOUT: $(head -1 "$dir/baseline/head.txt"), $(wc -l < "$dir/baseline/status.txt") status line(s), $(wc -l < "$dir/baseline/files.tsv") watched file(s)"
    ;;
  check)
    phase="${3:?phase}"
    [ -d "$dir/baseline" ] || die "no baseline in $dir (run snapshot first)"
    if drift_check "$dir/baseline" "$phase" "$dir"; then
      log "$COST_MAIN_CHECKOUT unchanged since the baseline ($phase)"
    else
      exit 3
    fi
    ;;
  *) die "unknown command $cmd" ;;
esac
