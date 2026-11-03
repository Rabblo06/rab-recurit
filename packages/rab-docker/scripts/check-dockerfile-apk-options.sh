#!/usr/bin/env bash
# Docker hardening review H1-L1: no Dockerfile under packages/rab-docker may point apk at another repository or skip
# signature checks on the command line. security-floors.sh checks /etc/apk/* inside the image; this checks the commands.
#
#   bash packages/rab-docker/scripts/check-dockerfile-apk-options.sh [file...]   (default: every tracked Dockerfile)
#
# Like Docker, comment lines are dropped (also inside a continued instruction) and backslash-continued lines are joined.
# Quote characters are deleted (so shell word concatenation such as a'pk' still reads apk) and brackets and commas are
# blanked (so exec-form RUN ["apk", "add", ...] is scanned like the shell form). A file that changes the escape character
# (# escape=) is refused: its continuations would not be joined correctly.
# Each instruction is split into commands at && || ; | and every command in which `apk` appears as a word (also after
# `if`, `then`, `!`, `$(`, a backtick, `=` or a path such as /sbin/apk) is checked for: -X with a separate or attached
# argument, alone or grouped (-X url, -Xurl, -qX url), and any long option apk could expand to --allow-untrusted,
# --repository, --repositories-file or --keys-dir: every --al…, --rep… and --ke… prefix (apk accepts unambiguous
# abbreviations such as --allow). Other commands' arguments (e.g. `curl -X POST`) are not checked. Exit 1 on any hit, on an
# unreadable file, on an unsupported escape directive, or if no file is checked. This is a best-effort lint that catches
# accidental or casual use; deliberate obfuscation is for code review, and security-floors.sh checks the image itself.
set -euo pipefail
fail() {
  echo "::error::$*"
  exit 1
}
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(git ls-files 'packages/rab-docker/*Dockerfile*')
fi
[ "${#files[@]}" -gt 0 ] || fail "no Dockerfile found under packages/rab-docker"
commands=""
for f in "${files[@]}"; do
  { [ -f "$f" ] && [ -r "$f" ]; } || fail "cannot read $f"
  if grep -qiE '^[[:space:]]*#[[:space:]]*escape[[:space:]]*=' "$f"; then fail "$f sets a Dockerfile escape directive; this check only supports the default backslash"; fi
  out="$(tr -d "\"'" < "$f" | tr "[]," "   " | awk -v F="$f" '
    function emit(text,   n, i, parts) { n = split(text, parts, /&&|\|\||;|\|/); for (i = 1; i <= n; i++) print F ": " parts[i] }
    /^[[:space:]]*#/ { next }
    { line = $0; if (sub(/\\[[:space:]]*$/, "", line)) { buf = buf line " "; next } emit(buf line); buf = "" }
    END { if (buf != "") emit(buf) }')" || fail "could not parse $f"
  commands+="$out"$'\n'
done
rc=0
apk_commands="$(printf '%s' "$commands" | grep -E '(^|[[:space:]/(`=!])apk([[:space:]]|$)')" || rc=$?
[ "$rc" -le 1 ] || fail "apk command scan failed (grep exit $rc)"
rc=0
hits="$(printf '%s' "$apk_commands" | grep -E -- '[[:space:]](-[[:alnum:]]*X|--(al|rep|ke)[[:alnum:]=-]*)')" || rc=$?
[ "$rc" -le 1 ] || fail "apk option scan failed (grep exit $rc)"
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  fail "apk repository override, alternative keys or --allow-untrusted in a Dockerfile (see above)"
fi
echo "checked: ${files[*]}"
