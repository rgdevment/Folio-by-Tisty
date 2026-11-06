#!/usr/bin/env bash
set -uo pipefail

title=${1:?the title of the issue}
body=${2:?the body of the issue}

said=$(gh issue list --state all --search "\"$title\" in:title" --json title --jq "map(select(.title == \"$title\")) | length") || exit 1
if [ "$said" != 0 ]; then
  echo "already said: $title"
  exit 0
fi
gh issue create --title "$title" --body "$body"
