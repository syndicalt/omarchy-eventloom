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

# Keep a Codex hook script if unregistration failed or any user-owned hook
# source still mentions it. Never edit config.toml or Codex's hook trust.
codex_dir="${CODEX_HOME:-$HOME/.codex}"
codex_unwired=false
if [ -x "$BIN_DIR/eventloom" ] && "$BIN_DIR/eventloom" unwire-codex-hooks >/dev/null; then
  codex_unwired=true
fi
if [ "$codex_unwired" = false ] || grep -Fq 'eventloom-codex-hook.sh' "$codex_dir/hooks.json" "$codex_dir/config.toml" 2>/dev/null; then
  [ ! -f "$codex_dir/hooks/eventloom-codex-hook.sh" ] || say "Codex still may refer to eventloom-codex-hook.sh; its script is kept. Check $codex_dir/hooks.json and config.toml."
else
  rm -f "$codex_dir/hooks/eventloom-codex-hook.sh"
  say "codex hooks unregistered"
fi

opencode_plugin="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/omarchy-eventloom.js"
if [ -f "$opencode_plugin" ] && grep -Fq 'omarchy-eventloom OpenCode adapter' "$opencode_plugin"; then
  rm -f "$opencode_plugin"
  say "opencode adapter removed"
fi

pi_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
case "$pi_dir" in
  "~") pi_dir="$HOME" ;;
  "~/"*) pi_dir="$HOME/${pi_dir#\~/}" ;;
esac
pi_extension="$pi_dir/extensions/omarchy-eventloom.js"
if [ -f "$pi_extension" ] && grep -Fq 'omarchy-eventloom Pi adapter' "$pi_extension"; then
  rm -f "$pi_extension"
  say "pi adapter removed"
fi

native_unwired=true
for agent in copilot gemini crush grok agy muse cursor-agent; do
  if [ ! -x "$BIN_DIR/eventloom" ] || ! "$BIN_DIR/eventloom" unwire-native-hooks --agent "$agent" >/dev/null; then
    native_unwired=false
  fi
done
native_script="$HOME/.local/share/eventloom/hooks/eventloom-native-hook.sh"
if [ "$native_unwired" = true ]; then
  rm -f "$native_script"
else
  say "some native hooks could not be unregistered; kept their neutral wrapper at $native_script"
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
