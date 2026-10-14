# Shared helpers for capture-mobile.sh (source this file; Git Bash on Windows
# or any POSIX shell with adb + node on PATH).
#
#   ADB      path to adb            (default: $LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe)
#   OUT      screenshot directory   (default: ../images/mobile/raw)
#   FIXTURE  fixture base URL       (default: http://localhost:4010)

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$(cd "$TOOLS_DIR/.." && pwd)"
ADB="${ADB:-$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe}"
OUT="${OUT:-$DOCS_DIR/images/mobile/raw}"
FIXTURE="${FIXTURE:-http://localhost:4010}"
PKG=com.rab.rab_staff
DUMP_LOCAL="${TMPDIR:-/tmp}/crewflow-ui.xml"
mkdir -p "$OUT"

export MSYS_NO_PATHCONV=1   # stop Git Bash rewriting /sdcard/... paths
# ...which means native Windows tools (node) need explicit Windows paths.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf %s "$1"; fi; }
UIFIND="$(winpath "$TOOLS_DIR/ui-find.cjs")"
DUMP_W="$(winpath "$DUMP_LOCAL")"

adb_() { "$ADB" "$@"; }
pause() { sleep "${1:-1.5}"; }

# Screenshot straight to PNG (exec-out avoids CRLF mangling).
shot() { adb_ exec-out screencap -p > "$OUT/$1.png"; echo "  shot $1.png"; }

tap() { adb_ shell input tap "$1" "$2"; }
swipe() { adb_ shell input swipe "$@"; }
back() { adb_ shell input keyevent KEYCODE_BACK; }
type_text() { adb_ shell input text "$(printf '%s' "$1" | sed 's/ /%s/g')"; }
hide_kb() { adb_ shell input keyevent KEYCODE_ESCAPE; }

# Refresh the uiautomator dump (Flutter semantics -> content-desc).
dump() {
  adb_ shell uiautomator dump /sdcard/crewflow-ui.xml >/dev/null 2>&1
  adb_ pull /sdcard/crewflow-ui.xml "$DUMP_W" >/dev/null 2>&1
}
# find <pattern> [nth] -> "x y"  (fresh dump each call)
find_el() { dump; node "$UIFIND" "$DUMP_W" "$1" "${2:-1}"; }
# tap_el <pattern> [nth] — waits up to ~10s for the element to appear.
tap_el() {
  local xy i
  for i in 1 2 3 4 5; do
    if xy=$(find_el "$1" "${2:-1}" 2>/dev/null); then tap $xy; return 0; fi
    sleep 2
  done
  echo "!! element not found: $1" >&2; return 1
}
wait_el() {
  local i
  for i in $(seq 1 "${2:-10}"); do
    find_el "$1" >/dev/null 2>&1 && return 0
    sleep 1.5
  done
  echo "!! timed out waiting for: $1" >&2; return 1
}
list_ui() { dump; node "$UIFIND" "$DUMP_W" --list; }

clean_status_bar() {
  adb_ shell settings put global sysui_demo_allowed 1
  local b="adb_ shell am broadcast -a com.android.systemui.demo -e command"
  $b enter >/dev/null
  $b clock -e hhmm 0941 >/dev/null
  $b battery -e level 100 -e plugged false >/dev/null
  $b network -e wifi show -e level 4 -e fully true >/dev/null
  $b network -e mobile hide >/dev/null
  $b notifications -e visible false >/dev/null
}

fresh_app() {
  adb_ shell pm clear "$PKG" >/dev/null
  adb_ shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
}

fixture_reset() { curl -s -X POST "$FIXTURE/__fixture/reset" >/dev/null; }
fixture_confirm_latest() { curl -s -X POST "$FIXTURE/__fixture/confirm/latest"; echo; }
