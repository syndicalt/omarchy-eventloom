#!/bin/sh
# omarchy-eventloom uninstaller — removes installed files, strips its hook
# entries from Claude settings, leaves every other hook (herdr, etc.) intact.
set -eu

LIB_DIR="$HOME/.local/lib/eventloom"
BIN_DIR="$HOME/.local/bin"
LOG_DIR="$HOME/.local/state/omarchy/agents/logs"

say() { printf '  %s\n' "$*"; }

# --- claude hooks: remove only eventloom commands, keep sibling hooks ---------
if [ -x "$BIN_DIR/eventloom" ]; then
  if "$BIN_DIR/eventloom" unwire-claude-hooks; then
    say "claude hooks stripped"
  else
    say "claude settings left unchanged (could not parse)"
  fi
fi
rm -f "$HOME/.claude/hooks/eventloom-hook.sh" "$HOME/.claude/hooks/eventloom-hook.mjs"

# --- files --------------------------------------------------------------------
rm -f "$HOME/.omp/agent/extensions/eventloom.ts"
rm -rf "$LIB_DIR" "$HOME/.local/lib/tapestry"
rm -f "$BIN_DIR/eventloom" "$BIN_DIR/omarchy-eventloom" "$BIN_DIR/omarchy-eventloom-inspect"
say "cli, lib, omp adapter removed"

# --- logs: kept unless --purge -------------------------------------------------
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$LOG_DIR"
  say "logs purged"
else
  say "logs kept at $LOG_DIR (run with --purge to delete)"
fi
say "uninstall complete."
