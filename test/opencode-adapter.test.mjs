import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenCodeAdapter } from "../lib/opencode-adapter.mjs";

const logRoot = mkdtempSync(path.join(tmpdir(), "eventloom-opencode-"));
const previousLogDir = process.env.EVENTLOOM_LOG_DIR;
process.env.EVENTLOOM_LOG_DIR = path.join(logRoot, "logs");
after(() => {
  if (previousLogDir === undefined) delete process.env.EVENTLOOM_LOG_DIR;
  else process.env.EVENTLOOM_LOG_DIR = previousLogDir;
  rmSync(logRoot, { recursive: true, force: true });
});

function harness() {
  const events = [], recalled = [];
  let closed = 0;
  const writer = { write: (event) => events.push(event), close: () => closed++, brief: async (...args) => { recalled.push(args); return "shared project briefing"; } };
  const hooks = createOpenCodeAdapter({ directory: "/work" }, writer);
  const fire = (type, properties) => hooks.event({ event: { type, properties } });
  return { hooks, events, recalled, fire, closed: () => closed };
}

test("OpenCode sessions, turns and disposal have separate lifetimes", async () => {
  const box = harness();
  await box.fire("session.created", { info: { id: "s", directory: "/work", title: "PRIVATE_TITLE" } });
  await box.fire("session.status", { sessionID: "s", status: { type: "busy" } });
  await box.fire("session.status", { sessionID: "s", status: { type: "busy" } });
  await box.fire("session.idle", { sessionID: "s" });
  assert.deepEqual(box.events.map((e) => e.type), ["agent.session.started", "agent.model.started", "agent.model.completed"]);
  await box.fire("session.status", { sessionID: "s", status: { type: "busy" } });
  await box.fire("session.error", { sessionID: "s", error: { message: "PRIVATE_ERROR" } });
  assert.equal(box.events.at(-1).type, "agent.model.failed");
  await box.fire("session.compacted", { sessionID: "s" });
  assert.equal(box.events.at(-1).type, "agent.session.resumed");
  await box.hooks.dispose();
  const count = box.events.length;
  await box.fire("server.instance.disposed", { directory: "/work" });
  assert.equal(box.events.length, count, "a session closes just once");
  assert.equal(box.events.at(-1).type, "agent.session.completed");
  assert.doesNotMatch(JSON.stringify(box.events), /PRIVATE_/);
});

test("OpenCode tool snapshots retain IDs and explicit failures without content or duplicates", async () => {
  const box = harness();
  await box.hooks["tool.execute.before"]({ sessionID: "s", callID: "call", tool: "bash" }, { args: { command: "PRIVATE_ARGUMENT" } });
  const part = { type: "tool", sessionID: "s", callID: "call", tool: "bash", state: { status: "running", input: { command: "PRIVATE_ARGUMENT" }, time: { start: 1000 } } };
  await box.fire("message.part.updated", { part });
  const finished = { ...part, state: { ...part.state, status: "completed", output: "PRIVATE_OUTPUT", metadata: { exit: 7 }, time: { start: 1000, end: 2500 } } };
  await box.fire("message.part.updated", { part: finished });
  await box.fire("message.part.updated", { part: finished });
  const tools = box.events.filter((e) => e.payload.tool);
  assert.deepEqual(tools.map((e) => e.type), ["agent.tool.started", "agent.tool.failed"]);
  assert.equal(tools[0].payload.tool_use_id, tools[1].payload.tool_use_id);
  assert.deepEqual(tools[0].payload.tool_input_keys, ["command"]);
  assert.equal(tools[1].payload.duration_ms, 1500);
  assert.equal(tools[1].payload.exit_code, 7);
  await box.fire("message.part.updated", { part: { ...part, callID: "second", state: { status: "error", error: "PRIVATE_ERROR", time: { start: 3000, end: 3200 } } } });
  assert.equal(box.events.at(-1).type, "agent.tool.failed");
  assert.doesNotMatch(JSON.stringify(box.events), /PRIVATE_|tool_response|input.*command.*PRIVATE/);
});

test("OpenCode memory adds to system context once per session and re-briefs after compaction", async () => {
  const box = harness();
  const transform = box.hooks["experimental.chat.system.transform"];
  for (let i = 0; i < 2; i++) {
    const output = { system: ["existing instructions"] };
    await transform({ sessionID: "s" }, output);
    assert.deepEqual(output.system, ["existing instructions", "shared project briefing"]);
  }
  assert.deepEqual(box.recalled, [["s", "/work"]]);
  await box.fire("session.compacted", { sessionID: "s" });
  await transform({ sessionID: "s" }, { system: [] });
  assert.equal(box.recalled.length, 2);
  const before = process.env.EVENTLOOM_MEMORY;
  try {
    process.env.EVENTLOOM_MEMORY = "0";
    const output = { system: [] };
    await transform({ sessionID: "s" }, output);
    assert.deepEqual(output.system, []);
  } finally { if (before === undefined) delete process.env.EVENTLOOM_MEMORY; else process.env.EVENTLOOM_MEMORY = before; }
});

test("OpenCode permissions record decisions without request content or changing decisions", async () => {
  const box = harness();
  const request = { sessionID: "s", id: "p", title: "PRIVATE_TITLE", metadata: { command: "PRIVATE_COMMAND" }, patterns: ["PRIVATE_PATTERN"] };
  await box.fire("permission.asked", request);
  await box.fire("permission.asked", request);
  await box.fire("permission.replied", { sessionID: "s", requestID: "p", reply: "reject" });
  const approvals = box.events.filter((e) => e.type.includes("approval"));
  assert.deepEqual(approvals.map((e) => e.type), ["agent.approval.requested", "agent.approval.resolved"]);
  assert.equal(approvals[1].payload.approved, false);
  assert.doesNotMatch(JSON.stringify(box.events), /PRIVATE_/);
});

test("OpenCode rejects malformed hook input without disrupting the agent", async () => {
  const box = harness();
  await assert.doesNotReject(box.hooks.event({}));
  await assert.doesNotReject(box.hooks["tool.execute.before"](null, {}));
  assert.deepEqual(box.events, []);
});
