#!/bin/sh
# Opens the Tapestry in the browser, starting its local server first if one of
# ours is not already answering. The server is left running; it only reads
# the log.
#
# The server answers for the log only to a key it makes at start-up, and
# leaves a page, readable by its owner alone, that carries that key to the
# browser. That page is what gets opened: an address on a command line shows
# in the process list, a path to a private file gives nothing away. For the
# same reason the key is handed to curl on stdin here, never as an argument.
set -eu

EVENTLOOM="$HOME/.local/bin/eventloom"
[ -x "$EVENTLOOM" ] || { echo "eventloom is not installed" >&2; exit 1; }
# The port the owner chose (eventloom config set tapestry_port <n>), unless
# the environment names another for this once.
PORT="${EVENTLOOM_TAPESTRY_PORT:-$("$EVENTLOOM" config get tapestry_port)}"
LOG_DIR="${EVENTLOOM_LOG_DIR:-$HOME/.local/state/omarchy/agents/logs}"
LAUNCH="$(dirname "$LOG_DIR")/tapestry/launch-$PORT.html"

# Is the server behind this port the one that wrote the launch page?
ours() {
  [ -f "$LAUNCH" ] || return 1
  key="$(sed -n 's/.*#key=\([A-Za-z0-9_-]*\).*/\1/p' "$LAUNCH")"
  [ -n "$key" ] || return 1
  status="$(printf 'header = "Authorization: Bearer %s"\n' "$key" \
    | curl -s -K - -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/weave.json?days=1" || true)"
  [ "$status" = 200 ]
}
answering() { curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; }

if ! ours; then
  if answering; then
    echo "port $PORT is held by a server this cannot use (an older tapestry, or something else); stop it, or choose another: eventloom config set tapestry_port <n>" >&2
    exit 1
  fi
  nohup "$EVENTLOOM" tapestry --port "$PORT" >/dev/null 2>&1 &
  tries=0
  until ours; do
    tries=$((tries + 1))
    [ "$tries" -lt 50 ] || { echo "the tapestry server did not start on port $PORT" >&2; exit 1; }
    sleep 0.1
  done
fi
exec xdg-open "$LAUNCH"
