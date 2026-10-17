#!/bin/sh
# Eventloom's Codex adapter. Input/output use the official command-hook
# protocol. It records metadata and never approves, denies or rewrites a
# tool call. Only an opted-in SessionStart briefing adds agent context.
# Failures are private and never fail the calling agent.
[ "${EVENTLOOM_DISABLE:-0}" = "1" ] && exit 0
eventloom="$HOME/.local/bin/eventloom"
[ -x "$eventloom" ] || exit 0

# A stack trace opens with a source location and the offending line; the line
# that starts with the error's name is the useful one. Failing that, the last.
crash_summary() {
  printf '%s\n' "$failure" | sed -n '/^[A-Za-z]*Error/{p;q;}' | grep . || printf '%s\n' "$failure" | tail -n 1
}

{ failure="$("$eventloom" codex-hook 2>&1 >&3)"; } 3>&1 && exit 0
case "$failure" in
  eventloom:*) ;; # eventloom recorded this failure itself
  *)
    # a crash before eventloom could report anything, e.g. a broken install
    log_dir="${EVENTLOOM_LOG_DIR:-$HOME/.local/state/omarchy/agents/logs}"
    errors="$(dirname "$log_dir")/eventloom-errors.log"
    umask 077
    mkdir -p "$(dirname "$errors")" 2>/dev/null && printf '%s\tcodex-hook\tcrashed: %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$(crash_summary)" >>"$errors" 2>/dev/null
    ;;
esac
exit 0
