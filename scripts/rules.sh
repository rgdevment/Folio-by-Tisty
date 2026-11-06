#!/usr/bin/env bash
set -uo pipefail

status=0
missed=0

amiss() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::error::%s\n' "$1"
  else
    printf 'x  %s\n' "$1"
  fi
  status=1
  missed=$((missed + 1))
}

went_well() {
  [ -n "${GITHUB_ACTIONS:-}" ] || printf 'ok %s\n' "$1"
}

looked_through() {
  case $2 in
    0) amiss "$1"; return 1 ;;
    1) return 0 ;;
    *) amiss "$3"; return 1 ;;
  esac
}

both_languages_carry_the_same_documents() {
  local pair one mark a b bad=0
  for pair in "README.md README.es.md" \
    "docs/TERMS.md docs/TERMINOS.md" \
    "docs/PRIVACY.md docs/PRIVACIDAD.md" \
    "docs/SECURITY.md docs/SEGURIDAD.md"; do
    set -- $pair
    for one in "$1" "$2"; do
      if [ ! -f "$one" ]; then
        amiss "$one is not here, so its other language was not compared"
        bad=1
        continue 2
      fi
    done
    for mark in '^#' '```' '^|'; do
      a=$(grep -c -- "$mark" "$1")
      b=$(grep -c -- "$mark" "$2")
      [ "$a" = "$b" ] || { amiss "$1 and $2 differ in '$mark': $a vs $b"; bad=1; }
    done
  done
  [ "$bad" = 1 ] || went_well "both languages carry the same documents"
}

no_token_kept_in_the_tree() {
  local token='AGE-SECRET-KEY-(PQ-)?1[0-9A-Z]{20,}|ya29\.[A-Za-z0-9_-]{20,}|1//0[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|sl\.[A-Za-z0-9_-]{40,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}'
  grep -rnIE "$token" scripts .github docs
  looked_through \
    "a provider's token or secret is in the tree; a real one goes up with wrangler secret put or into the repository's secrets" $? \
    "the tree could not be looked through for tokens" \
    && went_well "no provider token or secret is kept in the tree"
}

# The tables change before the code, and a deploy can go back: the version before has to go on reading them.
migrations_only_grow() {
  # What comes before any hyphen, so a comment may say the words. The sample keeps the pattern from going blind.
  local shrinks='^[^-]*\b(drop|rename)\b'
  if ! printf 'ALTER TABLE a DROP COLUMN b;\n' | grep -qiE "$shrinks"; then
    amiss "the pattern for what shrinks a table does not see a DROP"
    return
  fi
  grep -HniE "$shrinks" migrations/*.sql
  looked_through \
    "a migration drops or renames something, so the version running before it would break" $? \
    "the migrations could not be looked through" \
    && went_well "the migrations only grow"
}

cd "$(dirname "$0")/.." || exit 2
both_languages_carry_the_same_documents
no_token_kept_in_the_tree
migrations_only_grow
exit $status
