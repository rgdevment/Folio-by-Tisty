#!/usr/bin/env bash
set -uo pipefail

action=${1:?sums, or served and an address}
page=${2:?the folder of the built page}

code_files() {
  (cd "$page" && find . -type f \( -name '*.js' -o -name '*.css' -o -name index.html \) | sed 's|^\./||' | LC_ALL=C sort)
}

sums() {
  code_files | (cd "$page" && xargs sha256sum)
}

served() {
  local address=${1:?the address that serves the page}
  local received headers file challenged=0
  local differs=()
  received=$(mktemp)
  headers=$(mktemp)

  compare() {
    local name=$1
    shift
    if ! curl -s -D "$headers" -o "$received" "$@"; then
      differs+=("$name")
    elif grep -qi '^cf-mitigated:' "$headers"; then
      challenged=1
    elif ! cmp -s "$received" "$page/$name"; then
      differs+=("$name")
    fi
  }

  while IFS= read -r file; do
    if [ "$file" = index.html ]; then
      compare "$file" -H 'Sec-Fetch-Mode: navigate' "$address/AAAAAAAA"
    else
      compare "$file" "$address/$file"
    fi
  done < <(code_files)
  rm -f "$received" "$headers"

  if [ "$challenged" = 1 ]; then
    echo "::warning::$address challenged this runner, so part of the page was not compared"
  fi
  if [ "${#differs[@]}" -gt 0 ]; then
    echo "::error::$address serves something else than what was attested: ${differs[*]}"
    return 1
  fi
  echo "$address serves what was attested"
}

case $action in
  sums) sums ;;
  served) served "${3:-}" ;;
  *)
    echo "unknown action: $action" >&2
    exit 2
    ;;
esac
