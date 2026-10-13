#!/bin/sh
# omarchy-eventloom uninstaller. Removes what install.sh installed; other
# hooks in Claude's settings are left as they were. Kept on purpose: the logs
# (unless --purge) and ~/.claude/settings.json.eventloom-backup, the version
# of your settings from before the last change eventloom made to them.
set -eu

LIB_DIR="$HOME/.local/lib/eventloom"
BIN_DIR="$HOME/.local/bin"
LOG_DIR="$HOME/.local/state/omarchy/agents/logs"

say() { printf '  %s\n' "$*"; }

case "$#:${1:-}" in
  0: | 1:--purge) ;;
  *) echo "usage: uninstall.sh [--purge]" >&2; exit 1 ;;
esac

# Unregister before deleting the hook script: a registered hook that points
# at a missing file would fail on every Claude tool call. The script stays if
# settings.json still mentions it afterwards, whether because the file could
# not be edited or because a hook of your own calls it.
settings="$HOME/.claude/settings.json"
if [ -x "$BIN_DIR/eventloom" ] && "$BIN_DIR/eventloom" unwire-claude-hooks >/dev/null; then
  say "claude hooks unregistered"
fi
if [ -f "$settings" ] && grep -q 'eventloom-hook.sh' "$settings"; then
  say "~/.claude/settings.json still refers to eventloom-hook.sh, so the script is left in place."
  say "remove those entries by hand, then delete ~/.claude/hooks/eventloom-hook.sh"
else
  rm -f "$HOME/.claude/hooks/eventloom-hook.sh"
fi

# Sealed mode was set up as root and is not undone from here.
if [ -x "$BIN_DIR/eventloom" ] && "$BIN_DIR/eventloom" seal status 2>/dev/null | grep -q '^sealed mode is on'; then
  say "sealed mode is still set up. To remove it: sudo sh $(cd "$(dirname "$0")" && pwd)/seal/setup.sh --remove"
fi

rm -f "$HOME/.omp/agent/extensions/eventloom.ts"
rm -rf "$LIB_DIR"
rm -f "$BIN_DIR/eventloom" "$BIN_DIR/omarchy-eventloom" "$BIN_DIR/omarchy-eventloom-inspect"
say "cli, runtime and omp adapter removed"

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$LOG_DIR" "$(dirname "$LOG_DIR")/eventloom-errors.log"
  say "logs purged"
else
  say "logs kept at $LOG_DIR (run with --purge to delete)"
fi
say "uninstall complete."
