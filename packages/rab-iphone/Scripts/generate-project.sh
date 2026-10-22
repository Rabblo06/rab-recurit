#!/usr/bin/env bash
# Generates Crewflow.xcodeproj from project.yml. Run on macOS.
#   brew install xcodegen
#   ./Scripts/generate-project.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "error: xcodegen not found. Install it with: brew install xcodegen" >&2
  exit 1
fi

chmod +x Scripts/verify-release-config.sh

if [ ! -f Config/Local.xcconfig ]; then
  echo "note: Config/Local.xcconfig not found. Copy Config/Local.xcconfig.example to set"
  echo "      DEVELOPMENT_TEAM, CREWFLOW_BUNDLE_ID and API_BASE_URL for device builds."
fi

xcodegen generate --spec project.yml
echo "Generated Crewflow.xcodeproj. Open it with: open Crewflow.xcodeproj"
