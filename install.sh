#!/bin/sh
# omarchy-eventloom installer. Idempotent: run it again to upgrade.
set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$HOME/.local/lib/eventloom"
BIN_DIR="$HOME/.local/bin"
LOG_DIR="$HOME/.local/state/omarchy/agents/logs"

say() { printf '  %s\n' "$*"; }
die() { echo "install: $*" >&2; exit 1; }

[ "$#" -eq 0 ] || die "usage: install.sh (takes no arguments)"

# --- 1. runtime -------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || command -v bun >/dev/null 2>&1 || die "node >= 20 or bun is required (found node $NODE_MAJOR)"
elif ! command -v bun >/dev/null 2>&1; then
  die "bun or node >= 20 is required (https://bun.sh, or: sudo pacman -S nodejs npm)"
fi

# --- 2. dependencies, exactly as locked ----------------------------------------
# Installed into a staging directory and swapped in only on success, so a
# failed download during an upgrade leaves the working install untouched.
STAGE="$LIB_DIR/.staging"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$STAGE/"
if command -v npm >/dev/null 2>&1; then
  npm ci --prefix "$STAGE" --omit=dev --no-fund --no-audit --loglevel=error \
    || die "npm could not install @eventloom/runtime; the existing install is unchanged"
elif command -v bun >/dev/null 2>&1; then
  # bun reads package-lock.json and installs the versions it pins
  (cd "$STAGE" && bun install --production) \
    || die "bun could not install @eventloom/runtime; the existing install is unchanged"
else
  die "npm or bun is required to install @eventloom/runtime"
fi
[ -d "$STAGE/node_modules/@eventloom/runtime" ] || die "@eventloom/runtime is missing after install"

# --- 3. files: $LIB_DIR mirrors the repository layout ------------------------
mkdir -p "$LIB_DIR/lib" "$LIB_DIR/tapestry" "$BIN_DIR" "$LOG_DIR"
chmod 700 "$LOG_DIR"
find "$LOG_DIR" -name '*.jsonl' -exec chmod 600 {} +
rm -rf "$LIB_DIR/node_modules"
mv "$STAGE/node_modules" "$STAGE/package.json" "$STAGE/package-lock.json" "$LIB_DIR/"
rm -rf "$STAGE"
cp "$REPO_DIR"/lib/*.mjs "$REPO_DIR/lib/adapters.json" "$LIB_DIR/lib/"
cp -R "$REPO_DIR/tapestry/." "$LIB_DIR/tapestry/"
for name in eventloom omarchy-eventloom omarchy-eventloom-inspect; do
  cp "$REPO_DIR/bin/$name" "$BIN_DIR/$name"
  chmod +x "$BIN_DIR/$name"
done
# Releases before 0.2.0 kept their modules flat and the tapestry outside $LIB_DIR.
rm -f "$LIB_DIR/eventloom.mjs" "$LIB_DIR/engine.mjs" "$LIB_DIR/claude-settings.mjs" "$LIB_DIR/adapters.json"
rm -rf "$HOME/.local/lib/tapestry"
say "installed cli -> $BIN_DIR/eventloom"

# --- 4. omp adapter, when omp is present --------------------------------------
if [ -d "$HOME/.omp/agent" ]; then
  mkdir -p "$HOME/.omp/agent/extensions"
  cp "$REPO_DIR/extensions/eventloom.ts" "$HOME/.omp/agent/extensions/"
  say "omp adapter installed (loads on the next omp session)"
fi

# --- 5. claude adapter, when Claude Code is present ---------------------------
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$HOME/.claude/hooks"
  cp "$REPO_DIR/hooks/eventloom-hook.sh" "$HOME/.claude/hooks/"
  chmod +x "$HOME/.claude/hooks/eventloom-hook.sh"
  rm -f "$HOME/.claude/hooks/eventloom-hook.mjs"
  "$BIN_DIR/eventloom" wire-claude-hooks >/dev/null \
    || die "could not register the Claude hooks; fix ~/.claude/settings.json as described above and re-run"
  say "claude adapter registered in ~/.claude/settings.json"
fi

# --- 6. the install is done when doctor says the log works --------------------
"$BIN_DIR/eventloom" doctor || die "doctor reported a failure above; the install is incomplete"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on PATH" ;;
esac
say "install complete."
