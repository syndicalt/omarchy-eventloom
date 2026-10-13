// Drives the omp extension with the events omp emits and reads back what it
// hands to `eventloom ingest`, using a stand-in binary that saves its stdin.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { until } from "./helpers.mjs";

const home = mkdtempSync(path.join(tmpdir(), "eventloom-omp-"));
after(() => rmSync(home, { recursive: true, force: true }));
const binary = path.join(home, ".local", "bin", "eventloom");
const received = path.join(home, "ingested.ndjson");
const invocations = path.join(home, "invocations");
const errorLog = path.join(home, ".local", "state", "omarchy", "agents", "eventloom-errors.log");
mkdirSync(path.dirname(binary), { recursive: true });

function installStandIn(script) {
  writeFileSync(binary, `#!/bin/sh\necho run >> '${invocations}'\n${script}\n`);
  chmodSync(binary, 0o755);
}

// The extension reads its environment when it loads, as it does inside omp.
// Everything that could point it at the developer's real log is removed.
process.env.HOME = home;
delete process.env.EVENTLOOM_LOG_DIR;
delete process.env.EVENTLOOM_DISABLE;
delete process.env.EVENTLOOM_CORRELATION_ID;
const canLoadTypeScript = Boolean(process.features.typescript);
const { default: eventloomAdapter } = canLoadTypeScript ? await import("../extensions/eventloom.ts") : {};
const options = { skip: canLoadTypeScript ? false : "this Node cannot load TypeScript (needs 22.18 or later)" };

function fakeOmp() {
  const handlers = new Map();
  return {
    on: (name, handler) => handlers.set(name, handler),
    fire: (name, event = {}, ctx = {}) => handlers.get(name)(event, ctx),
    handlers,
  };
}

const context = (id) => ({ cwd: "/work", model: { id: "glm-5", baseUrl: "http://10.0.0.1/v1" }, sessionManager: { getSessionId: () => id } });
const ingested = () => readFileSync(received, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

// Runs a session, shuts omp down, and waits for `count` events to arrive.
async function ingestedAfter(count, run) {
  installStandIn(`cat >> '${received}'`);
  writeFileSync(received, "");
  writeFileSync(invocations, "");
  const omp = fakeOmp();
  eventloomAdapter(omp);
  run(omp);
  omp.fire("session_shutdown", {}, context("ignored"));
  return until(() => (ingested().length >= count ? ingested() : null));
}

test("a session is briefed once, before its first turn, and names itself to the shell", options, async () => {
  installStandIn(`[ "$1" = brief ] && { echo "memory for $5 in $7"; exit 0; }\ncat >> '${received}'`);
  const omp = fakeOmp();
  eventloomAdapter(omp);
  const ctx = context("sess-brief");
  assert.deepEqual(await omp.fire("before_agent_start", {}, ctx), {
    message: { customType: "eventloom-memory", content: "memory for sess-brief in /work", display: false, attribution: "agent" },
  });
  assert.equal(process.env.EVENTLOOM_ACTOR, "omp");
  assert.equal(process.env.EVENTLOOM_SESSION_ID, "sess-brief");
  assert.equal(await omp.fire("before_agent_start", {}, ctx), undefined, "once per session");

  // a briefing that fails or says nothing never holds the turn up
  installStandIn("exit 1");
  assert.equal(await omp.fire("before_agent_start", {}, context("sess-quiet")), undefined);
  process.env.EVENTLOOM_MEMORY = "0";
  installStandIn("echo unwanted");
  assert.equal(await omp.fire("before_agent_start", {}, context("sess-off")), undefined);
  delete process.env.EVENTLOOM_MEMORY;
  omp.fire("session_shutdown", {}, ctx);
});

test("a session with two turns and a tool call is one session, in order", options, async () => {
  const ctx = context("sess-1");
  const events = await ingestedAfter(10, (omp) => {
    omp.fire("session_start", {}, ctx);
    omp.fire("agent_start", {}, ctx);
    omp.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "cat .env", timeout: 5 } }, ctx);
    omp.fire("tool_execution_end", { toolCallId: "c1", toolName: "bash", isError: false, result: "SECRET=1" }, ctx);
    omp.fire("agent_end", {}, ctx);
    omp.fire("agent_start", {}, ctx);
    omp.fire("tool_execution_start", { toolCallId: "c2", toolName: "read", args: { path: "/nope" } }, ctx);
    omp.fire("tool_execution_end", { toolCallId: "c2", toolName: "read", isError: true }, ctx);
    omp.fire("agent_end", {}, ctx);
  });

  assert.deepEqual(events.map((event) => event.type), [
    "agent.session.started",
    "agent.model.started", "agent.tool.started", "agent.tool.completed", "agent.model.completed",
    "agent.model.started", "agent.tool.started", "agent.tool.failed", "agent.model.completed",
    "agent.session.completed",
  ]);
  assert.ok(events.every((event) => event.actor === "omp" && event.thread === "omp-sess-1"));
  assert.ok(events.every((event) => event.payload.session_id === "sess-1" && event.payload.correlation_id === "omp-sess-1"));
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.payload.occurred_at))));

  const [, modelStarted, toolStarted, toolCompleted] = events;
  assert.equal(modelStarted.payload.model, "glm-5", "the model id, not the provider configuration");
  assert.deepEqual(toolStarted.payload.tool_input_keys, ["command", "timeout"]);
  assert.equal(typeof toolCompleted.payload.duration_ms, "number");
  assert.doesNotMatch(JSON.stringify(events), /cat \.env|SECRET|10\.0\.0\.1/);
});

test("switching sessions closes one and opens or resumes the other", options, async () => {
  const events = await ingestedAfter(8, (omp) => {
    omp.fire("session_start", {}, context("a"));
    omp.fire("session_switch", { reason: "resume" }, context("b"));
    omp.fire("session_switch", { reason: "resume" }, context("b"));
    omp.fire("session_switch", { reason: "new" }, context("c"));
    omp.fire("session_switch", { reason: "fork" }, context("d"));
  });
  assert.deepEqual(events.map((event) => [event.type, event.payload.session_id]), [
    ["agent.session.started", "a"],
    ["agent.session.completed", "a"],
    ["agent.session.resumed", "b"],
    ["agent.session.completed", "b"],
    ["agent.session.started", "c"],
    ["agent.session.completed", "c"],
    ["agent.session.started", "d"],
    ["agent.session.completed", "d"],
  ]);
});

test("a burst is batched into a few writes and keeps the order it happened in", options, async () => {
  const ctx = context("burst");
  const events = await ingestedAfter(202, (omp) => {
    omp.fire("session_start", {}, ctx);
    for (let call = 0; call < 200; call++) {
      omp.fire("tool_execution_start", { toolCallId: `c${call}`, toolName: `tool${call}` }, ctx);
    }
  });
  assert.deepEqual(events.slice(1, -1).map((event) => event.payload.tool), Array.from({ length: 200 }, (_, call) => `tool${call}`));
  const writes = readFileSync(invocations, "utf8").trim().split("\n").length;
  assert.ok(writes <= 4, `202 events took ${writes} eventloom processes`);
});

test("at shutdown, events queued behind a slow write go to a second process at once", options, async () => {
  installStandIn(`sleep 2\ncat >> '${received}'`);
  writeFileSync(received, "");
  writeFileSync(invocations, "");
  const omp = fakeOmp();
  eventloomAdapter(omp);
  omp.fire("session_start", {}, context("slow")); // starts the slow write
  omp.fire("agent_start", {}, context("slow")); // queued behind it
  assert.equal(omp.fire("session_shutdown", {}, context("slow")), undefined, "nothing for omp to wait on");

  const runs = () => readFileSync(invocations, "utf8").split("\n").filter(Boolean).length;
  await until(() => runs() === 2, { timeoutMs: 1200 }); // well before the first write's 2 s are up
  const events = await until(() => (ingested().length >= 3 ? ingested() : null));
  // the two processes race for the log, so only membership is fixed here
  assert.deepEqual(events.map((event) => event.type).sort(), ["agent.model.started", "agent.session.completed", "agent.session.started"]);
});

test("a host that exits after shutdown is not held open by a write still in progress", options, async () => {
  installStandIn(`sleep 3\ncat >> '${received}'`);
  writeFileSync(received, "");
  const host = `
    const { default: adapter } = await import(${JSON.stringify(new URL("../extensions/eventloom.ts", import.meta.url).href)});
    const handlers = new Map();
    adapter({ on: (name, handler) => handlers.set(name, handler) });
    const ctx = { cwd: "/work", sessionManager: { getSessionId: () => "host" } };
    handlers.get("session_start")({}, ctx);
    handlers.get("session_shutdown")({}, ctx);
  `;
  const started = Date.now();
  const exited = spawnSync(process.execPath, ["--input-type=module", "-e", host], { env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(exited.status, 0, String(exited.stderr));
  assert.ok(Date.now() - started < 2000, `host took ${Date.now() - started} ms to exit with a 3 s write in progress`);
  const events = await until(() => (ingested().length >= 2 ? ingested() : null));
  // written by two processes, so only membership is fixed
  assert.deepEqual(events.map((event) => event.type).sort(), ["agent.session.completed", "agent.session.started"]);
});

test("a write in progress survives the host's process group being killed", options, async (t) => {
  installStandIn(`sleep 1\ncat >> '${received}'`);
  writeFileSync(received, "");
  writeFileSync(invocations, "");
  const host = `
    const { default: adapter } = await import(${JSON.stringify(new URL("../extensions/eventloom.ts", import.meta.url).href)});
    const handlers = new Map();
    adapter({ on: (name, handler) => handlers.set(name, handler) });
    handlers.get("session_start")({}, { cwd: "/work", sessionManager: { getSessionId: () => "killed" } });
    setInterval(() => {}, 1000);
  `;
  // its own process group, as a terminal gives a foreground program
  const child = spawn(process.execPath, ["--input-type=module", "-e", host], {
    detached: true,
    stdio: "ignore",
    env: { PATH: process.env.PATH, HOME: home },
  });
  t.after(() => child.kill("SIGKILL")); // in case the test fails before it gets that far
  await until(() => readFileSync(invocations, "utf8").includes("run"));
  process.kill(-child.pid, "SIGTERM"); // what closing the terminal does
  const events = await until(() => (ingested().length >= 1 ? ingested() : null));
  assert.equal(events[0].type, "agent.session.started");
});

test("EVENTLOOM_DISABLE=1 registers nothing", options, () => {
  process.env.EVENTLOOM_DISABLE = "1";
  try {
    const omp = fakeOmp();
    eventloomAdapter(omp);
    assert.equal(omp.handlers.size, 0);
  } finally {
    delete process.env.EVENTLOOM_DISABLE;
  }
});

test("a missing or crashing eventloom is recorded, and omp is not disturbed", options, async () => {
  const errors = () => (existsSync(errorLog) ? readFileSync(errorLog, "utf8") : "");
  const hidden = `${binary}.hidden`;
  renameSync(binary, hidden);
  try {
    const omp = fakeOmp();
    eventloomAdapter(omp);
    omp.fire("session_start", {}, context("x"));
    await until(() => /omp-adapter\tcould not run/.test(errors()));
  } finally {
    renameSync(hidden, binary);
  }

  // what node prints for an uncaught error: location, source line, caret, then the error
  installStandIn(`printf '%s\\n' 'file:///x/eventloom.mjs:1' 'throw new Error("boom");' '^' '' 'Error: boom' '    at file:///x' >&2\nexit 1`);
  const omp = fakeOmp();
  eventloomAdapter(omp);
  omp.fire("session_start", {}, context("y"));
  await until(() => /omp-adapter\teventloom ingest exited 1: Error: boom$/m.test(errors()));
});
