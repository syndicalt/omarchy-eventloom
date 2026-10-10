import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeHooksWired, hookCommand, mergeClaudeHooks, parseSettingsText, stripClaudeHooks } from "../lib/claude-settings.mjs";

const hook = "/home/o'brien/.claude/hooks/eventloom-hook.sh";

test("merge quotes hook paths and does not clobber a sibling command", () => {
  const settings = {
    model: "opus",
    hooks: {
      SessionStart: [{
        matcher: "*",
        hooks: [
          { type: "command", command: "herdr start", timeout: 5 },
          { type: "command", command: "bash '/old/eventloom-hook.sh' session_start", timeout: 10 },
        ],
      }],
    },
  };
  const merged = mergeClaudeHooks(settings, hook);
  assert.equal(merged.settings.model, "opus");
  const commands = merged.settings.hooks.SessionStart[0].hooks.map((entry) => entry.command);
  assert.deepEqual(commands[0], "herdr start");
  assert.equal(commands[1], hookCommand(hook, "session_start"));
  assert.equal(hookCommand(hook, "session_start"), "bash '/home/o'\\''brien/.claude/hooks/eventloom-hook.sh' session_start");
  assert.equal(merged.added, 2);
  assert.equal(merged.refreshed, 1);
  assert.equal(claudeHooksWired(merged.settings).wired, true);
});

test("re-merge refreshes in place instead of duplicating", () => {
  const once = mergeClaudeHooks({}, hook);
  const twice = mergeClaudeHooks(once.settings, "/new/eventloom-hook.sh");
  assert.equal(twice.added, 0);
  assert.equal(twice.refreshed, 3);
  assert.equal(twice.settings.hooks.PostToolUse.length, 1);
});

test("strip removes only eventloom commands", () => {
  const merged = mergeClaudeHooks({
    hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "herdr stop" }] }] },
  }, hook);
  merged.settings.hooks.Stop[0].hooks.push({ type: "command", command: hookCommand(hook, "session_stop") });
  const stripped = stripClaudeHooks(merged.settings);
  assert.deepEqual(stripped.settings.hooks.Stop, [{ matcher: "*", hooks: [{ type: "command", command: "herdr stop" }] }]);
  assert.equal(stripped.settings.hooks.SessionStart, undefined);
  assert.ok(stripped.removed >= 3);
});

test("invalid settings text is refused instead of replaced", () => {
  assert.throws(() => parseSettingsText("{", "/tmp/settings.json"), /refusing to rewrite/);
  assert.throws(() => parseSettingsText("[]", "/tmp/settings.json"), /root is not an object/);
});
