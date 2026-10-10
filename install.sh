#!/bin/sh
# omarchy-eventloom installer — zero-touch, idempotent.
# Copies sources out of this repo, wires adapters, verifies the result.
set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$HOME/.local/lib/eventloom"
BIN_DIR="$HOME/.local/bin"
LOG_DIR="$HOME/.local/state/omarchy/agents/logs"

say() { printf '  %s\n' "$*"; }

# --- 1. runtime: bun preferred (no npm step), node >= 20 fallback ------------
RUNTIME=""
if command -v bun >/dev/null 2>&1; then
  RUNTIME="bun"
elif command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || { echo "node >= 20 required (found $NODE_MAJOR). Install bun: https://bun.sh" >&2; exit 1; }
  RUNTIME="node"
else
  echo "Neither bun nor node found. Install bun: https://bun.sh (or: sudo pacman -S bun)" >&2
  exit 1
fi
say "runtime: $RUNTIME"

# --- 2. files ----------------------------------------------------------------
mkdir -p "$LIB_DIR" "$BIN_DIR" "$LOG_DIR"
cp "$REPO_DIR/lib/engine.mjs" "$REPO_DIR/lib/eventloom.mjs" "$REPO_DIR/lib/claude-settings.mjs" "$REPO_DIR/lib/adapters.json" "$LIB_DIR/"
mkdir -p "$LIB_DIR/../tapestry"
cp "$REPO_DIR/tapestry/server.mjs" "$REPO_DIR/tapestry/index.html" "$REPO_DIR/tapestry/weave.js" "$LIB_DIR/../tapestry/"
cp "$REPO_DIR/bin/eventloom" "$REPO_DIR/bin/omarchy-eventloom" "$REPO_DIR/bin/omarchy-eventloom-inspect" "$BIN_DIR/"
chmod +x "$BIN_DIR/eventloom" "$BIN_DIR/omarchy-eventloom" "$BIN_DIR/omarchy-eventloom-inspect"
say "installed cli -> $BIN_DIR/eventloom"

# --- 3. one pinned runtime for bun and node -----------------------------------
# Both launchers resolve @eventloom/runtime from this prefix, so a desktop bun
# and a terminal node cannot seal with different versions.
RUNTIME_VERSION="1.0.0"
read_runtime_version() {
  pkg="$LIB_DIR/node_modules/@eventloom/runtime/package.json"
  if command -v node >/dev/null 2>&1; then
    node -e "try{console.log(require('$pkg').version)}catch{console.log('')}" 2>/dev/null || true
  elif command -v bun >/dev/null 2>&1; then
    bun -e "try{console.log(require('$pkg').version)}catch{console.log('')}" 2>/dev/null || true
  fi
}
installed="$(read_runtime_version)"
if [ "$installed" != "$RUNTIME_VERSION" ]; then
  say "installing @eventloom/runtime@$RUNTIME_VERSION"
  npm install --prefix "$LIB_DIR" --no-fund --no-audit --silent "@eventloom/runtime@$RUNTIME_VERSION"
fi

# --- 4. omp adapter: only when omp is present --------------------------------
if [ -d "$HOME/.omp/agent" ] || command -v omp >/dev/null 2>&1; then
  mkdir -p "$HOME/.omp/agent/extensions"
  cp "$REPO_DIR/extensions/eventloom.ts" "$HOME/.omp/agent/extensions/"
  say "omp adapter installed (loads on next omp session)"
fi

# --- 5. claude adapter: idempotent settings merge ----------------------------
HOOK="$HOME/.claude/hooks/eventloom-hook.sh"
if [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1; then
  mkdir -p "$HOME/.claude/hooks"
  cp "$REPO_DIR/hooks/eventloom-hook.sh" "$REPO_DIR/hooks/eventloom-hook.mjs" "$HOME/.claude/hooks/"
  chmod +x "$HOOK"
  "$HOME/.local/bin/eventloom" wire-claude-hooks "$HOOK"
  say "claude adapter wired (SessionStart/Stop/PostToolUse)"
fi

# --- 6. acceptance gate ------------------------------------------------------
if ! "$HOME/.local/bin/eventloom" verify; then
  echo "eventloom: verify failed; install aborted" >&2
  exit 1
fi
"$HOME/.local/bin/eventloom" inspect
say "install complete."
