#!/usr/bin/env bash
# Builds a debug APK of rab-mobile at a commit (from a clean `git archive`, outside every checkout, so the measured
# checkouts are never written) and runs flutter/measure-flutter.mjs on the emulator. Each step is one heavy-run.
#   bash flutter/measure-flutter.sh --src-commit 614796f0 --out <dir> [--window-s 120] [--users kind:email,...]
#   bash flutter/measure-flutter.sh --src-tree /c/rab-ai-wt/c1 --out <dir>       (after: the worktree's current files)
# Build copy: C:/rab-ai-wt/cost-work/flutter-src/<tag>/packages/rab-mobile. Only android/gradle.properties is changed in
# the copy (Gradle heap 8 GB -> 2 GB, so the build fits next to the Docker VM); the Dart/Android sources are untouched.
set -euo pipefail
ST="$(cd "$(dirname "$0")/.." && pwd)"
. "$ST/../lib/common.sh"
HEAVY_RUN="${COST_HEAVY_RUN:-/c/rab-ai-wt/setup/heavy-run.sh}"; LABEL="${COST_HEAVY_LABEL:-c1-f0}"
SRC_COMMIT=""; SRC_TREE=""; OUT=""; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --src-commit) SRC_COMMIT="$2"; shift 2 ;;
    --src-tree) SRC_TREE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --window-s|--users|--avd) EXTRA+=("$1" "$2"); shift 2 ;;
    --keep-emulator) EXTRA+=("$1"); shift ;;
    *) die "unknown option $1" ;;
  esac
done
[ -n "$OUT" ] || die "--out required"; assert_outside_main "--out" "$OUT"; mkdir -p "$OUT"
if [ -n "$SRC_COMMIT" ]; then
  TAG="$(GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$REPO")" rev-parse "${SRC_COMMIT}^{commit}" | cut -c1-8)"
  SRC="$COST_WORK/flutter-src/$TAG"
  if [ ! -f "$SRC/packages/rab-mobile/pubspec.yaml" ]; then
    mkdir -p "$SRC"; GIT_OPTIONAL_LOCKS=0 git -C "$(hostpath "$REPO")" archive "$SRC_COMMIT" packages/rab-mobile | tar -x -C "$SRC"
  fi
elif [ -n "$SRC_TREE" ]; then
  assert_outside_main "--src-tree" "$SRC_TREE"
  TAG="tree-$(date -u +%Y%m%d%H%M%S)"; SRC="$COST_WORK/flutter-src/$TAG"; mkdir -p "$SRC/packages"
  # tracked + untracked-not-ignored files only (no build/ or .dart_tool/ from the tree)
  (cd "$SRC_TREE" && GIT_OPTIONAL_LOCKS=0 git ls-files -co --exclude-standard packages/rab-mobile | tar -cf - -T -) | tar -x -C "$SRC"
else
  die "--src-commit or --src-tree required"
fi
APP="$SRC/packages/rab-mobile"
printf 'org.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=768m -XX:ReservedCodeCacheSize=256m\nkotlin.daemon.jvmargs=-Xmx768m\nandroid.useAndroidX=true\n' > "$APP/android/gradle.properties"
APK="$APP/build/app/outputs/flutter-apk/app-debug.apk"
echo "source=$SRC tag=$TAG apiUrl=http://10.0.2.2:$COST_API_PORT/rest/v1" > "$OUT/flutter-build.meta"
if [ ! -f "$APK" ]; then
  log "building debug APK in $APP"
  bash "$HEAVY_RUN" "$LABEL" bash -c "cd '$APP' && flutter pub get && flutter build apk --debug --dart-define=API_URL=http://10.0.2.2:$COST_API_PORT/rest/v1 && (cd android && ./gradlew --stop >/dev/null 2>&1 || true)" > "$OUT/flutter-build.log" 2>&1 \
    || { tail -30 "$OUT/flutter-build.log"; die "APK build failed (see $OUT/flutter-build.log)"; }
fi
sha256sum "$APK" >> "$OUT/flutter-build.meta"
bash "$HEAVY_RUN" "$LABEL" env COST_SECRETS="$(hostpath "$COST_SECRETS")" node "$(hostpath "$ST/flutter/measure-flutter.mjs")" --apk "$(hostpath "$APK")" --out "$(hostpath "$OUT")" "${EXTRA[@]}"
