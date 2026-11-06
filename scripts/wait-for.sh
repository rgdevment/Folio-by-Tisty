#!/usr/bin/env bash
set -uo pipefail

# A check answers 0 when it holds, 2 when Cloudflare challenged this runner, and anything else to try again.
what=${1:?what is being checked}
tries=${2:?how many times to try}
pause=${3:?how many seconds between tries}
shift 3

for attempt in $(seq 1 "$tries"); do
  verdict=0
  "$@" || verdict=$?
  case $verdict in
    0)
      echo "$what answers as it should"
      exit 0
      ;;
    2)
      echo "::warning::$what challenged this runner, so what went up stays without being checked"
      exit 0
      ;;
  esac
  echo "not yet ($attempt/$tries)"
  [ "$attempt" = "$tries" ] || sleep "$pause"
done
echo "::error::$what does not answer as it should after the deploy"
exit 1
