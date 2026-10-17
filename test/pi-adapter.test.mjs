import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiAdapter, piAgentDir } from "../lib/pi-adapter.mjs";
import { useTempLogDir } from "./helpers.mjs";

function harness(t) {
  useTempLogDir(t);
  const handlers = new Map(), events = [], briefs = [];
  let closed = 0;
  const api = { on: (name, handler) => handlers.set(name, handler) };
  createPiAdapter(api, {
    write: (event) => events.push(event), close: () => closed++,
    brief: async (...args) => { briefs.push(args); return "shared memory briefing"; },
  });
  const ctx = (id) => ({ cwd: "/work", sessionManager: { getSessionId: () => id }, model: { id: "fixture", apiKey: "PRIVATE_KEY" } });
  const fire = (name, event = {}, id = "s") => handlers.get(name)(event, ctx(id));
  return { events, briefs, fire, closed: () => closed };
}

test("Pi session replacement uses shutdown/start rather than omp's switch events", async (t) => {
  const box = harness(t);
  await box.fire("session_start", { reason: "startup", prompt: "PRIVATE_PROMPT" });
  await box.fire("agent_start");
  await box.fire("agent_end", { messages: ["PRIVATE_REPLY"] });
  assert.deepEqual(box.events.map((e) => e.type), ["agent.session.started", "agent.model.started", "agent.model.completed"]);
  await box.fire("session_shutdown", { reason: "resume" });
  await box.fire("session_start", { reason: "resume" }, "other");
  await box.fire("session_shutdown", { reason: "quit" }, "other");
  assert.deepEqual(box.events.slice(-3).map((e) => [e.type, e.payload.session_id]), [
    ["agent.session.completed", "s"], ["agent.session.resumed", "other"], ["agent.session.completed", "other"],
  ]);
  assert.equal(box.closed(), 2);
  assert.doesNotMatch(JSON.stringify(box.events), /PRIVATE_/);
});

test("Pi tools preserve parallel IDs, outcomes and argument names but no contents", async (t) => {
  const box = harness(t);
  await box.fire("session_start", { reason: "new" });
  for (const toolCallId of ["a", "b"]) await box.fire("tool_execution_start", { toolCallId, toolName: "bash", args: { command: "PRIVATE_ARGUMENT" } });
  await box.fire("tool_execution_end", { toolCallId: "b", toolName: "bash", isError: true, result: "PRIVATE_ERROR" });
  await box.fire("tool_execution_end", { toolCallId: "a", toolName: "bash", isError: false, result: "PRIVATE_OUTPUT" });
  const tools = box.events.filter((e) => e.payload.tool);
  assert.deepEqual(tools.map((e) => [e.type, e.payload.tool_use_id]), [
    ["agent.tool.started", "a"], ["agent.tool.started", "b"], ["agent.tool.failed", "b"], ["agent.tool.completed", "a"],
  ]);
  assert.equal(tools[2].payload.outcome, "failure");
  assert.equal(tools[3].payload.outcome, "success");
  assert.doesNotMatch(JSON.stringify(box.events), /PRIVATE_/);
});

test("Pi memory is a hidden persistent message, once per session or tree/compaction", async (t) => {
  const box = harness(t);
  await box.fire("session_start", { reason: "startup" });
  assert.deepEqual(await box.fire("before_agent_start", { prompt: "PRIVATE_PROMPT" }), {
    message: { customType: "eventloom-memory", content: "shared memory briefing", display: false },
  });
  assert.equal(await box.fire("before_agent_start"), undefined);
  await box.fire("session_tree", { summaryEntry: "PRIVATE_SUMMARY" });
  await box.fire("before_agent_start");
  await box.fire("session_compact", { compactionEntry: "PRIVATE_SUMMARY" });
  await box.fire("before_agent_start");
  assert.equal(box.briefs.length, 3);
  assert.doesNotMatch(JSON.stringify(box.events), /PRIVATE_/);
});

test("Pi errors and missing session attribution never throw into the agent", async (t) => {
  const box = harness(t);
  await box.fire("session_start", {}, null);
  assert.equal(box.events.length, 0);
  await box.fire("agent_start");
  await box.fire("message_end", { message: { role: "assistant", stopReason: "error", content: "PRIVATE_OUTPUT" } });
  assert.equal(box.events.at(-1).type, "agent.model.failed");
  const before = box.events.length;
  await box.fire("agent_end");
  assert.equal(box.events.length, before);
  assert.doesNotMatch(JSON.stringify(box.events), /PRIVATE_/);
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
});
