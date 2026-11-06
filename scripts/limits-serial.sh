#!/usr/bin/env bash
set -uo pipefail

# A reader never takes an older file than the one it holds, so a serial that does not grow reaches nobody.
cd "$(dirname "$0")/.." || exit 2
base=${1:?the commit to compare with}
head=${2:-HEAD}
file=docs/limits.json

serial_at() {
  git show "$1:$file" 2>/dev/null | grep -m1 '"serial"' | grep -oE '[0-9]+'
}

terms_version_at() {
  git show "$1:$file" 2>/dev/null | grep -A1 '"terms"' | grep -oE '"version": "[0-9]+"' | grep -oE '[0-9]+'
}

before=$(serial_at "$base")
[ -n "$before" ] || exit 0

if ! git diff --quiet "$base" "$head" -- docs/TERMINOS.md docs/TERMS.md; then
  was=$(terms_version_at "$base")
  now=$(terms_version_at "$head")
  if [ -z "$now" ] || [ "${was:-0}" -ge "$now" ]; then
    echo "x  the terms changed and their version in $file went from ${was:-none} to ${now:-none}: sign it again in this same change"
    exit 1
  fi
  echo "ok the terms changed and their version grew from ${was:-none} to $now"
fi

git diff --quiet "$base" "$head" -- "$file" "$file.minisig" && exit 0

after=$(serial_at "$head")
if [ -z "$after" ] || [ "$after" -le "$before" ]; then
  echo "x  $file went from serial $before to ${after:-none}: sign it again, since readers keep the newest they saw"
  exit 1
fi
echo "ok the serial of $file grew from $before to $after"
