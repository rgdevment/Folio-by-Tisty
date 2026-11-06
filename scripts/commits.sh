#!/usr/bin/env bash
set -uo pipefail

shape='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._-]+\))?: .+'
most=120
status=0

amiss() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::error::%s\n' "$1"
  else
    printf 'x  %s\n' "$1"
  fi
  status=1
}

# Strict is for a title, which reaches main and is measured with nothing let through.
weighed() {
  local who=$1 said=$2 strict=${3:-}
  said=$(printf '%s' "$said" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [ -z "$strict" ]; then
    case $said in
      "Merge branch '"* | "Merge pull request #"* | "Merge remote-tracking branch '"* | \
        "Merge commit '"* | "Merge tag '"* | "fixup! "* | "squash! "* | "amend! "*)
        return
        ;;
    esac
  fi
  if ! printf '%s' "$said" | grep -qE "$shape"; then
    amiss "$who does not read type(optional scope): change"
    printf '  %s\n' "$said"
    return
  fi
  # A subject becomes the squash title, and GitHub ends that with " (#1234)", so it leaves the room.
  local room=$most
  [ -n "$strict" ] || room=$((most - 8))
  # Bytes minus UTF-8 continuation bytes: ${#said} counts bytes when a GUI client spawns git without a locale.
  local long
  long=$(printf '%s' "$said" | LC_ALL=C tr -d '\200-\277' | wc -c | tr -d ' ')
  if [ "$long" -gt "$room" ]; then
    amiss "$who is $long characters, keep it under $room"
    printf '  %s\n' "$said"
  fi
}

said_so() {
  if [ "$status" -eq 1 ]; then
    echo ""
    echo "Expected: type(optional scope): change, on one line with nothing under it"
    echo "Types:    feat fix docs style refactor perf test build ci chore revert"
    echo "Example:  feat(parser): recognise weekday names in Spanish"
  fi
  exit $status
}

if [ "${1:-}" = "--subject" ] || [ "${1:-}" = "--title" ]; then
  [ -n "${2:-}" ] || { echo "usage: commits.sh --subject|--title <text>"; exit 2; }
  weighed "the subject" "$2" "$([ "$1" = "--title" ] && echo strict)"
  [ "$status" -eq 0 ] && [ -z "${GITHUB_ACTIONS:-}" ] && printf 'ok the subject is well formed\n'
  said_so
fi

range=${1:-}
[ -n "$range" ] || { echo "usage: commits.sh <range> | --subject <text> | --title <text>"; exit 2; }

listed=$(git rev-list --no-merges "$range" 2>&1) || {
  printf '%s\n' "$listed"
  amiss "the commits between $range could not be listed, so no subject was looked at"
  exit 1
}

seen=0
while IFS=$'\x1f' read -r -d '' sha author subject body; do
  [ -n "$sha" ] || continue
  seen=$((seen + 1))
  weighed "${sha:0:8}" "$subject"
  case $subject in "fixup! "* | "squash! "* | "amend! "*) continue ;; esac
  if [ -n "$(printf '%s' "$body" | tr -d '[:space:]')" ] && [ "$author" != "dependabot[bot]" ]; then
    amiss "${sha:0:8} carries lines under its subject; a commit is one line"
  fi
done < <(git log -z --no-merges --format='%H%x1f%an%x1f%s%x1f%b' "$range")

[ "$status" -eq 0 ] && [ -z "${GITHUB_ACTIONS:-}" ] && printf 'ok %s commit subject(s) well formed\n' "$seen"
said_so
