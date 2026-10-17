import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { codexHookToEvent, codexToolOutcome } from "../lib/codex-hook.mjs";
import { layoutWeave } from "../tapestry/layout.mjs";
import { deriveLinks, weaveSpec } from "../tapestry/server.mjs";
const hooks = JSON.parse(readFileSync(new URL("./fixtures/codex-hooks.json", import.meta.url)));
const options = { now: new Date("2026-10-16T12:00:00Z"), env: {} };
const convert = (hook) => codexHookToEvent(hook, options);

test("Codex session sources and subagents preserve identities and parent correlation", () => {
  const opened = convert(hooks.SessionStart);
  assert.equal(opened.type, "agent.session.started");
  assert.equal(opened.actorId, "codex");
  assert.equal(opened.threadId, "codex-thr_parent");
  for (const source of ["resume", "compact"]) assert.equal(convert({ ...hooks.SessionStart, source }).type, "agent.session.resumed");
  for (const source of ["startup", "clear", "fork"]) assert.equal(convert({ ...hooks.SessionStart, source }).type, "agent.session.started");
  assert.equal(convert(hooks.SessionEnd).type, "agent.session.completed");
  const child = convert(hooks.SubagentStart);
  assert.equal(child.type, "agent.session.started");
  assert.equal(child.payload.session_id, "thr_child");
  assert.equal(child.payload.parent_session_id, "thr_parent");
  assert.equal(child.payload.correlation_id, opened.payload.correlation_id);
  assert.equal(convert(hooks.SubagentStop).threadId, child.threadId);
  assert.equal(convert(hooks.SubagentStop).type, "agent.session.completed");
  assert.equal(codexHookToEvent(hooks.SubagentStart, { ...options, env: { EVENTLOOM_CORRELATION_ID: "release" } }).payload.correlation_id, "release");
});

test("Codex hooks keep argument names and IDs but discard all content and transcripts", () => {
  for (const hook of Object.values(hooks)) {
    const event = convert(hook);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_|private\/|tool_response|transcript|last_assistant/);
  }
  const start = convert(hooks.PreToolUse);
  assert.equal(start.type, "agent.tool.started");
  assert.deepEqual(start.payload.tool_input_keys, ["command", "description"]);
  assert.equal(start.payload.tool_use_id, "call_1");
  assert.equal(convert(hooks.PermissionRequest).type, "agent.approval.requested");
  assert.equal(convert(hooks.PostToolUse).type, "agent.tool.failed");
  assert.equal(convert(hooks.PostToolUse).payload.exit_code, 1);
  assert.equal(convert({ ...hooks.PostToolUse, tool_response: { isError: true, content: "PRIVATE" } }).type, "agent.tool.failed");
  assert.deepEqual(codexToolOutcome({ isError: true, exit_code: 0 }), { outcome: "failure" });
  assert.deepEqual(codexToolOutcome({ isError: false }), { outcome: "success" });
  assert.deepEqual(codexToolOutcome({ exit_code: 0 }), { outcome: "success", exit_code: 0 });
  for (const response of ["Exit code: 1", null, [], { output: "Exit code: 1" }]) {
    assert.deepEqual(codexToolOutcome(response), { outcome: "unknown" });
  }
});

test("Codex unknown hooks do not invent events, and unattributable known hooks fail", () => {
  for (const hook_event_name of ["Stop", "UserPromptSubmit", "FutureEvent"]) assert.equal(convert({ hook_event_name }), null);
  assert.throws(() => convert([]), /not a JSON object/);
  assert.throws(() => convert({ ...hooks.SessionStart, session_id: "" }), /no session_id/);
  assert.throws(() => convert({ ...hooks.SubagentStop, agent_id: undefined }), /no agent_id/);
  assert.throws(() => convert({ ...hooks.PreToolUse, tool_name: null }), /no tool_name/);
});

test("parallel same-named tools pair by call ID through the server projection", () => {
  const events = [
    { id: "a", type: "agent.tool.started", call: "a", minute: 0 },
    { id: "b", type: "agent.tool.started", call: "b", minute: 1 },
    { id: "be", type: "agent.tool.failed", call: "b", minute: 2 },
    { id: "ae", type: "agent.tool.completed", call: "a", minute: 3 },
  ].map((e) => ({ id: e.id, ts: new Date(Date.UTC(2026, 9, 16, 12, e.minute)).toISOString(), family: "tool", actor: "codex", session: "s", tool: "Bash", type: e.type, ok: !e.type.endsWith("failed"), payload: { tool_use_id: e.call } }));
  const actions = layoutWeave(weaveSpec(events)).actions;
  assert.deepEqual(actions.map((a) => a.events.map((e) => e.id)), [["a", "ae"], ["b", "be"]]);
  assert.equal(actions[0].ok, true);
  assert.equal(actions[1].ok, false);
});

test("a subagent's opening event draws a fork from its parent session", () => {
  assert.deepEqual(deriveLinks([
    { id: "p", type: "agent.tool.started", actor: "codex", session: "parent" },
    { id: "c", type: "agent.session.started", actor: "codex", session: "child", payload: { parent_session_id: "parent" } },
  ]), [{ from: "p", to: "c", kind: "fork" }]);
});
