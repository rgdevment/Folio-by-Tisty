#!/usr/bin/env bash
set -euo pipefail

database=${1:?the D1 database to export}
out=${2:?the file to write}
shift 2

tables_worth_restoring="SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'seen_[0-9]*' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT IN ('net_day', 'net_hour') ORDER BY name"
attempts=3
wait_seconds=${BACKUP_WAIT_SECONDS:-20}

list_tables() {
  local attempt said reason
  for attempt in $(seq 1 "$attempts"); do
    said=$(npx --no-install wrangler d1 execute "$database" "$@" --json --command "$tables_worth_restoring" 2> /dev/null) || true
    if jq -er '.[0].results[].name' <<< "$said" 2> /dev/null; then
      return 0
    fi
    reason=$(jq -r '.error.notes[0].text // .error.text // "no answer"' <<< "$said" 2> /dev/null || echo "no answer")
    echo "the tables could not be listed, try $attempt of $attempts: $reason" >&2
    [ "$attempt" = "$attempts" ] || sleep "$wait_seconds"
  done
  return 1
}

# Silent on purpose: an export prints a link to the plain dump, and this repository's logs are public.
quietly() {
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if npx --no-install wrangler d1 "$@" > "$out.log" 2>&1; then
      rm -f "$out.log"
      return 0
    fi
    rm -f "$out.log"
    echo "wrangler d1 $1 failed, try $attempt of $attempts, and its output stays hidden" >&2
    [ "$attempt" = "$attempts" ] || sleep "$wait_seconds"
  done
  return 1
}

tables=$(list_tables "$@")

picked=()
while IFS= read -r table; do
  picked+=(--table "${table%$'\r'}")
done <<< "$tables"

quietly export "$database" "$@" --no-data --output "$out.schema"
quietly export "$database" "$@" --no-schema "${picked[@]}" --output "$out.data"
cat "$out.schema" "$out.data" > "$out"
rm -f "$out.schema" "$out.data"
