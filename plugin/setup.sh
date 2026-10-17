#!/bin/sh
# Run by the Omarchy plugin's service when it loads. `omarchy plugin add` only
# clones this repository, so this is what installs the eventloom CLI and its
# adapters, and installs them again after `omarchy plugin update`.
#
# It does nothing when what is installed already came from this checkout:
# this script leaves a stamp naming the commit (or, outside git, the version).
# `--force` reinstalls regardless.
# `--check` prints the checkout identity and exits 3 when installation is
# needed, or 0 when current. It never installs or contacts the network.
set -eu

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LIB_DIR="$HOME/.local/lib/eventloom"
STAMP="$LIB_DIR/.installed-from"

case "$#:${1:-}" in
  0: | 1:--force | 1:--check) ;;
  *) echo "usage: setup.sh [--force|--check]" >&2; exit 1 ;;
esac

checkout="$(git -C "$PLUGIN_DIR" rev-parse HEAD 2>/dev/null || true)"
if [ -z "$checkout" ]; then
  checkout="version $(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$PLUGIN_DIR/package.json" | head -n 1)"
fi

if [ "${1:-}" = "--check" ]; then
  printf '%s\n' "$checkout"
  if [ -x "$HOME/.local/bin/eventloom" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$checkout" ]; then
    exit 0
  fi
  exit 3
fi

if [ "${1:-}" != "--force" ] && [ -x "$HOME/.local/bin/eventloom" ] \
  && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$checkout" ]; then
  echo "eventloom is up to date"
  exit 0
fi

sh "$PLUGIN_DIR/install.sh"
printf '%s\n' "$checkout" >"$STAMP"
