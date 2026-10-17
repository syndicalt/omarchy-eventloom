import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { claudeHookToEvent } from "../lib/claude-hook.mjs";

const hooks = JSON.parse(readFileSync(new URL("./fixtures/claude-hooks.json", import.meta.url), "utf8"));
const SESSION = hooks.SessionStart.session_id;
const options = { now: new Date("2026-10-10T12:00:00.000Z"), env: {} };
const convert = (hook) => claudeHookToEvent(hook, options);

test("foreign harness compatibility hooks do not record Claude events or errors", () => {
  assert.equal(convert({ hook_event_name: "PostToolUse", hookEventName: "post_tool_use", sessionId: "grok-session", toolName: "bash" }), null);
  assert.equal(convert({ hook_event_name: "SessionStart", session_id: "cursor-session", cursor_version: "fixture" }), null);
});

test("session hooks map to the session lifecycle", () => {
  assert.deepEqual(convert(hooks.SessionStart), {
    type: "agent.session.started",
    actorId: "claude",
    threadId: `claude-${SESSION}`,
    payload: {
      session_id: SESSION,
      correlation_id: `claude-${SESSION}`,
      occurred_at: "2026-10-10T12:00:00.000Z",
      cwd: "/work",
      source: "startup",
    },
  });
  assert.equal(convert({ ...hooks.SessionStart, source: "resume" }).type, "agent.session.resumed");
  assert.equal(convert({ ...hooks.SessionStart, source: "compact" }).type, "agent.session.resumed");
  assert.equal(convert({ ...hooks.SessionStart, source: "clear" }).type, "agent.session.started");
  const ended = convert(hooks.SessionEnd);
  assert.equal(ended.type, "agent.session.completed");
  assert.equal(ended.payload.reason, "prompt_input_exit");
});

test("the end of a reply is not the end of a session", () => {
  assert.equal(convert(hooks.Stop), null);
});

test("tool hooks record the tool and its argument names, never the content", () => {
  const completed = convert(hooks.PostToolUse);
  assert.equal(completed.type, "agent.tool.completed");
  assert.equal(completed.payload.tool, "Bash");
  assert.deepEqual(completed.payload.tool_input_keys, ["command", "description"]);
  assert.doesNotMatch(JSON.stringify(completed), /netrc|hunter2/);

  const failed = convert(hooks.PostToolUseFailure);
  assert.equal(failed.type, "agent.tool.failed");
  assert.doesNotMatch(JSON.stringify(failed), /does not exist/);
});

test("a non-object tool_input is recorded without argument names", () => {
  const event = convert({ ...hooks.PostToolUse, tool_input: "raw string" });
  assert.equal(event.type, "agent.tool.completed");
  assert.equal("tool_input_keys" in event.payload, false);
});

test("EVENTLOOM_CORRELATION_ID joins the session to a wider task", () => {
  const event = claudeHookToEvent(hooks.SessionStart, { ...options, env: { EVENTLOOM_CORRELATION_ID: "goal-7" } });
  assert.equal(event.payload.correlation_id, "goal-7");
});

test("input that cannot be attributed to a session is rejected, not filed under a placeholder", () => {
  const { session_id: _omitted, ...anonymous } = hooks.PostToolUse;
  assert.throws(() => convert(anonymous), /has no session_id/);
  assert.throws(() => convert([]), /not a JSON object/);
});
