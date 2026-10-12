import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLAUDE_HOOK_EVENTS } from "../lib/claude-hook.mjs";
import { tempDir } from "./helpers.mjs";
import {
  hookCommand, missingClaudeHooks, readSettingsFile, unwireClaudeHooks, wireClaudeHooks, writeSettingsFile,
} from "../lib/claude-settings.mjs";

const HOOK = "/home/o'brien/.claude/hooks/eventloom-hook.sh";
const tempFile = (t) => path.join(tempDir(t, "settings"), "settings.json");

test("wiring registers every hook event and keeps the rest of the file", () => {
  const settings = { model: "opus", permissions: { deny: ["Read(.env)"] } };
  const wired = wireClaudeHooks(settings, HOOK);
  assert.deepEqual(Object.keys(wired.hooks), CLAUDE_HOOK_EVENTS);
  assert.equal(wired.model, "opus");
  assert.deepEqual(wired.permissions, { deny: ["Read(.env)"] });
  assert.deepEqual(missingClaudeHooks(wired, HOOK), []);
  assert.deepEqual(settings, { model: "opus", permissions: { deny: ["Read(.env)"] } }, "input is not mutated");
});

test("the hook path is shell-quoted", () => {
  assert.equal(hookCommand(HOOK), "sh '/home/o'\\''brien/.claude/hooks/eventloom-hook.sh'");
});

test("wiring twice changes nothing, and a new path replaces the old one", () => {
  const once = wireClaudeHooks({}, HOOK);
  assert.deepEqual(wireClaudeHooks(once, HOOK), once);
  const moved = wireClaudeHooks(once, "/new/eventloom-hook.sh");
  assert.equal(moved.hooks.PostToolUse.length, 1);
  assert.equal(moved.hooks.PostToolUse[0].hooks[0].command, "sh '/new/eventloom-hook.sh'");
});

test("entries from older releases are migrated; sibling hooks survive in place", () => {
  const legacy = {
    hooks: {
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: "bash '/old/eventloom-hook.sh' session_stop" }] }],
      PostToolUse: [{
        matcher: "*",
        hooks: [
          { type: "command", command: "audit-hook --strict" },
          { type: "command", command: "bash '/old/eventloom-hook.sh' post_tool" },
        ],
      }],
    },
  };
  const wired = wireClaudeHooks(legacy, HOOK);
  assert.equal(wired.hooks.Stop, undefined, "Stop is no longer an eventloom hook");
  assert.deepEqual(wired.hooks.PostToolUse[0], { matcher: "*", hooks: [{ type: "command", command: "audit-hook --strict" }] });
  assert.equal(wired.hooks.PostToolUse[1].hooks[0].command, hookCommand(HOOK));
});

test("unwiring removes only eventloom commands", () => {
  const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "herdr stop" }] }] } };
  const { settings, removed } = unwireClaudeHooks(wireClaudeHooks(original, HOOK));
  assert.deepEqual(settings, original);
  assert.equal(removed, CLAUDE_HOOK_EVENTS.length);
  assert.deepEqual(unwireClaudeHooks(wireClaudeHooks({ model: "opus" }, HOOK)).settings, { model: "opus" });
  assert.deepEqual(missingClaudeHooks(settings, HOOK), CLAUDE_HOOK_EVENTS);
});

test("a hook registered for another path, or for only some tools, counts as missing", () => {
  const elsewhere = wireClaudeHooks({}, "/gone/eventloom-hook.sh");
  assert.deepEqual(missingClaudeHooks(elsewhere, HOOK), CLAUDE_HOOK_EVENTS);

  const narrowed = wireClaudeHooks({}, HOOK);
  narrowed.hooks.PostToolUse[0].matcher = "Write";
  assert.deepEqual(missingClaudeHooks(narrowed, HOOK), ["PostToolUse"]);
});

test("a user's own hook that mentions the script, and entries they left empty, are not ours to remove", () => {
  const theirs = {
    hooks: {
      Stop: [],
      PostToolUse: [
        { matcher: "Bash", hooks: [] },
        { hooks: [{ type: "command", command: "sh ~/.claude/hooks/eventloom-hook.sh; notify-send done" }] },
        { hooks: [{ type: "command", command: "~/bin/backup-eventloom-hook.sh.d/run" }] },
      ],
    },
  };
  assert.deepEqual(unwireClaudeHooks(theirs), { settings: theirs, removed: 0 });
  assert.deepEqual(unwireClaudeHooks(wireClaudeHooks(theirs, HOOK)).settings, theirs);
});

test("a hooks table that is not Claude's shape is refused with a message, not guessed at", () => {
  for (const hooks of ["x", ["x"], { SessionStart: {} }, { SessionStart: "x" }]) {
    assert.throws(() => wireClaudeHooks({ hooks }, HOOK), /in Claude settings is not .*left unchanged/);
    assert.throws(() => missingClaudeHooks({ hooks }), /left unchanged/);
  }
});

test("a settings file that cannot be parsed is an error", (t) => {
  const file = tempFile(t);
  writeFileSync(file, '{\n  // my settings\n  "model": "opus",\n}\n');
  assert.throws(() => readSettingsFile(file), /not valid JSON.*left unchanged/);
  writeFileSync(file, "[]");
  assert.throws(() => readSettingsFile(file), /does not hold a JSON object/);
  assert.deepEqual(readSettingsFile(path.join(path.dirname(file), "absent.json")), {});
});

test("writes keep a backup and the exact file mode, and skip when nothing changed", (t) => {
  const file = tempFile(t);
  writeFileSync(file, '{"model":"opus"}', { mode: 0o644 });
  const umask = process.umask(0o077);
  t.after(() => process.umask(umask));
  assert.equal(writeSettingsFile(file, { model: "sonnet" }), true);
  assert.equal(readFileSync(`${file}.eventloom-backup`, "utf8"), '{"model":"opus"}');
  assert.equal(statSync(file).mode & 0o777, 0o644, "the umask must not narrow an existing file's mode");
  assert.deepEqual(readSettingsFile(file), { model: "sonnet" });
  assert.equal(writeSettingsFile(file, { model: "sonnet" }), false);
});

test("a symlinked settings file is written through, not replaced", (t) => {
  const file = tempFile(t);
  const dotfiles = path.join(path.dirname(file), "dotfiles");
  mkdirSync(dotfiles);
  const real = path.join(dotfiles, "claude-settings.json");
  writeFileSync(real, '{"model":"opus"}');
  symlinkSync(real, file);
  writeSettingsFile(file, { model: "sonnet" });
  assert.equal(readlinkSync(file), real);
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { model: "sonnet" });
});

test("a symlink whose target does not exist yet is written through too", (t) => {
  const file = tempFile(t);
  const real = path.join(path.dirname(file), "not-yet", "settings.json");
  symlinkSync(real, file);
  assert.equal(writeSettingsFile(file, { model: "opus" }), true);
  assert.equal(readlinkSync(file), real);
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { model: "opus" });
  assert.equal(existsSync(`${file}.eventloom-backup`), false);
});
