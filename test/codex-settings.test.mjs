import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_HOOK_EVENTS } from "../lib/codex-hook.mjs";
import { codexHome, missingCodexHooks, unwireCodexHooks, wireCodexHooks } from "../lib/codex-settings.mjs";
const file = "/home/o'brien/.codex/hooks/eventloom-codex-hook.sh";

test("Codex wiring preserves other hooks, is idempotent, and unwires exactly", () => {
  const original = { description: "Mine", extra: 12, hooks: {
    PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "notify-send done", timeout: 5 }] }],
    Stop: [{ hooks: [{ type: "command", command: "my-hook" }] }],
  } };
  const wired = wireCodexHooks(original, file);
  assert.deepEqual(missingCodexHooks(wired, file), []);
  assert.deepEqual(wireCodexHooks(wired, file), wired);
  assert.deepEqual(unwireCodexHooks(wired).settings, original);
  assert.equal(unwireCodexHooks(wired).removed, CODEX_HOOK_EVENTS.length);
  assert.deepEqual(original.hooks.Stop, wired.hooks.Stop);
  assert.equal(wired.hooks.SessionStart[0].hooks[0].command, "sh '/home/o'\\''brien/.codex/hooks/eventloom-codex-hook.sh'");
  const titles = CODEX_HOOK_EVENTS.map(event => wired.hooks[event].at(-1).hooks[0].statusMessage);
  assert.ok(titles.every(title => typeof title === "string" && title.startsWith("Eventloom: ")));
  assert.equal(new Set(titles).size, CODEX_HOOK_EVENTS.length);
  const legacy = structuredClone(wired);
  for (const event of CODEX_HOOK_EVENTS) delete legacy.hooks[event].at(-1).hooks[0].statusMessage;
  assert.deepEqual(wireCodexHooks(legacy, file), wired);
  const moved = wireCodexHooks(wired, "/new/eventloom-codex-hook.sh");
  assert.deepEqual(missingCodexHooks(moved, file), CODEX_HOOK_EVENTS);
  assert.deepEqual(missingCodexHooks(moved, "/new/eventloom-codex-hook.sh"), []);
});

test("Codex registration checks reject restricted, disabled and wrong-path hooks", () => {
  for (const modify of [
    entry => { entry.matcher = "Bash"; },
    entry => { entry.enabled = false; },
    entry => { entry.hooks[0].enabled = false; },
    entry => { entry.hooks[0].command = "some-other-hook"; },
  ]) {
    const settings = wireCodexHooks({}, file);
    modify(settings.hooks.PostToolUse[0]);
    assert.deepEqual(missingCodexHooks(settings, file), ["PostToolUse"]);
  }
  assert.equal(codexHome({ CODEX_HOME: "/custom" }), "/custom");
});

test("invalid Codex hook structures are left unchanged, not guessed at", () => {
  for (const hooks of [[], "bad", { SessionStart: {} }, { SessionStart: [null] }, { SessionStart: [{ hooks: "bad" }] }, { SessionStart: [{ hooks: [null] }] }, { SessionStart: [{ hooks: [{ type: "command" }] }] }]) {
    const settings = { hooks };
    const before = structuredClone(settings);
    assert.throws(() => wireCodexHooks(settings, file), /left unchanged/);
    assert.deepEqual(settings, before);
  }
  const userHook = { hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "notify-send eventloom-codex-hook.sh" }] }] } };
  assert.deepEqual(unwireCodexHooks(userHook), { settings: userHook, removed: 0 });
});
