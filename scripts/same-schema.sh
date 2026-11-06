#!/usr/bin/env bash
set -euo pipefail

database=${1:?the D1 database to compare}
shift
if [ "$#" -eq 0 ]; then
  echo "say where it is, as with --remote" >&2
  exit 2
fi

what_the_code_reads="SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'seen_[0-9]*' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name <> 'd1_migrations' ORDER BY name"
attempts=3
wait_seconds=${SCHEMA_WAIT_SECONDS:-20}

schema_of() {
  local attempt said
  for attempt in $(seq 1 "$attempts"); do
    said=$(npx --no-install wrangler d1 execute "$database" "$@" --json --command "$what_the_code_reads" 2> /dev/null) || true
    if jq -ec '.[0].results' <<< "$said" 2> /dev/null; then
      return 0
    fi
    [ "$attempt" = "$attempts" ] || sleep "$wait_seconds"
  done
  echo "the schema of $database could not be read" >&2
  return 1
}

fresh=$(mktemp -d)
trap 'rm -rf "$fresh"' EXIT
mkdir -p "$fresh/dist/page"
cp wrangler.toml "$fresh/"
cp -r migrations "$fresh/"
npx --no-install wrangler d1 migrations apply "$database" --local --cwd "$fresh" > /dev/null 2>&1

wanted=$(schema_of --local --cwd "$fresh")
found=$(schema_of "$@")
if [ "$wanted" != "$found" ]; then
  echo "::error::$database is not what the migrations make: was one of them changed after it was applied?"
  exit 1
fi
echo "$database is what the migrations make"
