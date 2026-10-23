#!/usr/bin/env bash
# Build phase: fail a Release build that would ship a placeholder or
# non-HTTPS API host, or the placeholder bundle identifier. Debug builds pass
# through (the app itself shows a configuration screen for the placeholder).
set -euo pipefail

if [ "${CONFIGURATION:-}" != "Release" ]; then
  exit 0
fi

fail() {
  echo "error: $1" >&2
  exit 1
}

case "${API_BASE_URL:-}" in
  https://*) ;;
  *) fail "Release API_BASE_URL must be HTTPS (got '${API_BASE_URL:-}'). Set it in Config/Release.local.xcconfig or CI." ;;
esac

case "${API_BASE_URL}" in
  *.invalid/*|*.invalid) fail "Release API_BASE_URL is still the .invalid placeholder." ;;
esac

case "${API_BASE_URL}" in
  */rest/v1) ;;
  *) fail "API_BASE_URL must end with /rest/v1 (got '${API_BASE_URL}')." ;;
esac

if [ "${CREWFLOW_BUNDLE_ID:-}" = "com.example.crewflow" ]; then
  fail "Release CREWFLOW_BUNDLE_ID is still the com.example placeholder."
fi

if [ -n "${CONSOLE_URL:-}" ]; then
  case "${CONSOLE_URL}" in
    https://*) ;;
    *) fail "Release CONSOLE_URL must be HTTPS when set." ;;
  esac
fi
