#!/usr/bin/env bash
set -uo pipefail

action=${1:?sums, served or detects}
# Cloudflare carries a new deploy's assets to every edge within seconds, so a miss right after it is tried again.
TRIES=${SERVED_TRIES:-6}
WAIT=${SERVED_WAIT:-10}

# As a browser asks, because Cloudflare adds its analytics script only for one.
as_browser() {
  curl -s --max-time 10 \
    -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' \
    -H 'Accept: text/html,application/xhtml+xml' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' "$@"
}

code_files() {
  (cd "$page" && find . -type f \( -name '*.js' -o -name '*.css' -o -name index.html -o -name home.html -o -name 404.html -o -name widget-frame.html \) | sed 's|^\./||' | LC_ALL=C sort)
}

sums() {
  code_files | (cd "$page" && xargs sha256sum)
}

served_once() {
  local address=$1 last=$2
  local received headers file challenged=0 prefetches=0 asset
  local differs=()
  received=$(mktemp)
  headers=$(mktemp)

  compare() {
    local name=$1
    shift
    if ! "$@" -D "$headers" -o "$received"; then
      differs+=("$name")
    elif grep -qi '^cf-mitigated:' "$headers"; then
      challenged=1
    elif ! cmp -s "$received" "$page/$name"; then
      differs+=("$name")
    fi
  }

  while IFS= read -r file; do
    case $file in
      index.html)
        compare "$file" as_browser "$address/AAAAAAAA"
        grep -qi '^speculation-rules:' "$headers" && prefetches=1
        ;;
      home.html) compare "$file" as_browser "$address/" ;;
      */index.html) compare "$file" as_browser "$address/${file%index.html}" ;;
      404.html) compare "$file" as_browser "$address/404" ;;
      widget-frame.html) compare "$file" as_browser "$address/widget-frame" ;;
      *) compare "$file" curl -s --max-time 10 "$address/$file" ;;
    esac
  done < <(code_files)

  asset=$(code_files | grep -m1 '^assets/')
  if [ -n "$asset" ] && [ "$challenged" = 0 ]; then
    curl -s --max-time 10 -H "Accept-Encoding: br, gzip" -D "$headers" -o /dev/null "$address/$asset"
    grep -qi '^cache-control:.*immutable' "$headers" || differs+=("the cache of $asset")
    grep -qi '^content-encoding:' "$headers" || differs+=("the compression of $asset")
  fi
  rm -f "$received" "$headers"

  if [ "$challenged" = 1 ]; then
    echo "::warning::$address challenged this runner, so part of the page was not compared"
  fi
  if [ "$prefetches" = 1 ]; then
    echo "::warning::Cloudflare adds Speculation-Rules to $address, so a browser prefetches pages a reader only hovered over: turn off Speed Brain in that zone"
  fi
  if [ "${#differs[@]}" -gt 0 ]; then
    if [ "$last" = 1 ]; then
      echo "::error::$address serves something else than what was attested: ${differs[*]}"
    else
      echo "$address does not serve yet what was attested: ${differs[*]}; trying again in ${WAIT}s"
    fi
    return 1
  fi
  echo "$address serves what was attested"
}

served() {
  local address=${1:?the address that serves the page} try
  for ((try = 1; try < TRIES; try++)); do
    served_once "$address" 0 && return 0
    sleep "$WAIT"
  done
  served_once "$address" 1
}

detects() {
  local address=${1:?an address where Cloudflare adds its script}
  if ! as_browser "$address" | grep -q cloudflareinsights; then
    echo "::warning::Cloudflare added no script to $address for this request, so the comparisons may no longer ask as a browser does"
  fi
}

case $action in
  sums)
    page=${2:?the folder of the built page}
    sums
    ;;
  served)
    page=${2:?the folder of the built page}
    served "${3:-}"
    ;;
  detects) detects "${2:-}" ;;
  *)
    echo "unknown action: $action" >&2
    exit 2
    ;;
esac
