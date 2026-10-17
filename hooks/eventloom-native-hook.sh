#!/bin/sh
# Native observer: one valid neutral response, even after an installation or
# recording failure. Diagnostics remain in the user's private Eventloom log.
agent="$1"
event="$2"
neutral() {
  case "$agent:$event" in
    agy:PreToolUse) printf '%s\n' '{"decision":"allow"}' ;;
    *) printf '%s\n' '{}' ;;
  esac
}
[ "${EVENTLOOM_DISABLE:-0}" = "1" ] && { neutral; exit 0; }
eventloom="$HOME/.local/bin/eventloom"
[ -x "$eventloom" ] || { neutral; exit 0; }
# Buffer stdout: a partial response from a failed process is not valid JSON.
umask 077
log_dir="${EVENTLOOM_LOG_DIR:-$HOME/.local/state/omarchy/agents/logs}"
errors="$(dirname "$log_dir")/eventloom-errors.log"
mkdir -p "$(dirname "$errors")" 2>/dev/null || { neutral; exit 0; }
if response="$("$eventloom" native-hook --agent "$agent" --event "$event" 2>/dev/null)"; then
  printf '%s\n' "$response"
else
  printf '%s\tnative-hook\t%s hook recording failed\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$agent" >>"$errors" 2>/dev/null
  neutral
fi
exit 0
