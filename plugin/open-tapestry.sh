#!/bin/sh
# Opens the Tapestry in the browser, starting its local server first if it is
# not already answering. The server is left running; it only reads the log.
set -eu

PORT="${EVENTLOOM_TAPESTRY_PORT:-4747}"
EVENTLOOM="$HOME/.local/bin/eventloom"
answering() { curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/weave.js"; }

[ -x "$EVENTLOOM" ] || { echo "eventloom is not installed" >&2; exit 1; }
if ! answering; then
  nohup "$EVENTLOOM" tapestry --port "$PORT" >/dev/null 2>&1 &
  tries=0
  until answering; do
    tries=$((tries + 1))
    [ "$tries" -lt 30 ] || { echo "the tapestry server did not start on port $PORT" >&2; exit 1; }
    sleep 0.1
  done
fi
exec xdg-open "http://127.0.0.1:$PORT/?days=7"
