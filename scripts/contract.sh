#!/usr/bin/env bash
set -uo pipefail

# Reads Tisty's release tags from stdin and prints the newest contract, only if it is newer than the one installed here.
cd "$(dirname "$0")/.." || exit 2

pinned=$(grep -oE 'download/contracts-v[0-9]+\.[0-9]+\.[0-9]+/' package.json | sed -E 's|download/contracts-v||; s|/$||' | head -1)
if [ -z "$pinned" ]; then
  echo "package.json does not install the contract from a contracts-v* release" >&2
  exit 2
fi

versions=$(grep -E '^contracts-v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^contracts-v//' | sort -V)
# Its hash is in the lockfile and npm ci reads that link, so a release that is gone breaks every install here.
if ! printf '%s\n' "$versions" | grep -qxF "$pinned"; then
  echo "the release of the contract installed here, $pinned, is not among Tisty's" >&2
  exit 2
fi

newest=$(printf '%s\n' "$versions" | tail -1)
[ "$newest" = "$pinned" ] || printf '%s\n' "$newest"
