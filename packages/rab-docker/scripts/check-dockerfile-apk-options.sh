#!/usr/bin/env bash
# Docker hardening review H1-L1: no Dockerfile under packages/rab-docker may point apk at another repository or skip
# signature checks on the command line. security-floors.sh checks /etc/apk/* inside the image; this checks the commands.
#
#   bash packages/rab-docker/scripts/check-dockerfile-apk-options.sh [file...]   (default: every tracked Dockerfile)
#
# Backslash-continued lines are joined and split into commands at && || ; | and every command that runs `apk` is
# checked for: -X with a separate or attached argument (-X url, -Xurl), any --rep… prefix (--repository,
# --repositories-file and their unambiguous abbreviations), any --allow-u… prefix (--allow-untrusted) and --keys-dir
# (alternative signing keys). Arguments of other commands (e.g. `curl -X POST`) are not checked.
# Exit 1 on any hit or if no file is checked.
set -euo pipefail
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(git ls-files 'packages/rab-docker/*Dockerfile*')
fi
[ "${#files[@]}" -gt 0 ] || { echo "::error::no Dockerfile found under packages/rab-docker"; exit 1; }
hits="$(
  for f in "${files[@]}"; do
    awk -v F="$f" '
      function emit(text,   n, i, parts) { n = split(text, parts, /&&|\|\||;|\|/); for (i = 1; i <= n; i++) print F ": " parts[i] }
      { line = $0; if (sub(/\\[[:space:]]*$/, "", line)) { buf = buf line " "; next } emit(buf line); buf = "" }
      END { if (buf != "") emit(buf) }' "$f"
  done | grep -E ': [[:space:]]*(RUN[[:space:]]+)?(--[^[:space:]]+[[:space:]]+)*([^[:space:]]*/)?apk[[:space:]]' \
       | grep -E -- '[[:space:]](-X|--rep|--allow-u|--keys-dir)' || true
)"
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "::error::apk repository override, alternative keys or --allow-untrusted in a Dockerfile (see above)"
  exit 1
fi
echo "checked: ${files[*]}"
