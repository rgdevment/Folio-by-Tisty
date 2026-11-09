#!/usr/bin/env bash
set -euo pipefail

# The signed limits live only on their branch; main builds and checks against a copy that git never keeps.
cd "$(dirname "$0")/.." || exit 2
wanted=${LIMITS_SHA:-limits}
git fetch --quiet --depth 1 origin "$wanted"
git show FETCH_HEAD:limits.json > docs/limits.json
git show FETCH_HEAD:limits.json.minisig > docs/limits.json.minisig
sha=$(git rev-parse FETCH_HEAD)
if [ -n "${GITHUB_ENV:-}" ]; then echo "LIMITS_SHA=$sha" >> "$GITHUB_ENV"; fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "limits_sha=$sha" >> "$GITHUB_OUTPUT"; fi
echo "ok docs/limits.json is the limits branch at ${sha:0:8}, serial $(jq .serial docs/limits.json)"
