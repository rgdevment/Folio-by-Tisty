#!/usr/bin/env bash
set -uo pipefail

# A reader never takes an older file than the one it holds, so a serial that does not grow reaches nobody.
older=${1:?the commit of the limits branch before}
newer=${2:?the commit of the limits branch after}
file=limits.json

serial_at() {
  git show "$1:$file" 2>/dev/null | grep -m1 '"serial"' | grep -oE '[0-9]+'
}

terms_at() {
  git show "$1:$file" 2>/dev/null | jq -c '.terms // null'
}

terms_version_at() {
  git show "$1:$file" 2>/dev/null | jq -r '.terms.version // empty'
}

before=$(serial_at "$older")
[ -n "$before" ] || exit 0
git diff --quiet "$older" "$newer" -- "$file" "$file.minisig" && exit 0

after=$(serial_at "$newer")
if [ -z "$after" ] || [ "$after" -le "$before" ]; then
  echo "x  $file went from serial $before to ${after:-none}: sign it again, since readers keep the newest they saw"
  exit 1
fi
echo "ok the serial of $file grew from $before to $after"

if [ "$(terms_at "$older")" != "$(terms_at "$newer")" ]; then
  was=$(terms_version_at "$older")
  now=$(terms_version_at "$newer")
  if [ -z "$now" ] || [ "${was:-0}" -ge "$now" ]; then
    echo "x  the terms it names changed and their version went from ${was:-none} to ${now:-none}: raise it"
    exit 1
  fi
  echo "ok the terms it names changed and their version grew from ${was:-none} to $now"
fi
