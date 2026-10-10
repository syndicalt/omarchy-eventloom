#!/bin/sh
# eventloom claude adapter — reads hook JSON from stdin, appends to the universal agent log.
# Opt-out: EVENTLOOM_DISABLE=1. Missing runtime is reported on stderr and does not fail Claude.
set -eu

event="${1:-}"
[ -n "$event" ] || exit 0
[ "${EVENTLOOM_DISABLE:-0}" = "1" ] && exit 0

hook_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
if command -v node >/dev/null 2>&1; then
  runtime=node
elif command -v bun >/dev/null 2>&1; then
  runtime=bun
else
  echo "eventloom: hook skipped, node or bun is required" >&2
  exit 0
fi

exec "$runtime" "$hook_dir/eventloom-hook.mjs" "$event"
