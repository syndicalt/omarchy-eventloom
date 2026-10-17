import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AGENT_COMMANDS } from "../lib/agents.mjs";
import { runAgent } from "../lib/run-agent.mjs";
import { tempDir, until, useTempLogDir } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../lib/eventloom.mjs", import.meta.url));
function machine(t) {
  const home = tempDir(t, "run"), tools = path.join(home, "tools"), logs = path.join(home, "logs");
  mkdirSync(tools);
  for (const command of Object.values(AGENT_COMMANDS)) symlinkSync(process.execPath, path.join(tools, command));
  const env = { HOME: home, PATH: tools, EVENTLOOM_LOG_DIR: logs };
  const run = (agent, args, extra = {}) => spawnSync(process.execPath, [CLI, "run", agent, "--", ...args], { cwd: home, env: { ...env, ...extra }, encoding: "utf8" });
  const events = () => readdirSync(logs).filter((file) => file.endsWith(".jsonl")).flatMap((file) => readFileSync(path.join(logs, file), "utf8").trim().split("\n").map(JSON.parse));
  return { home, env, run, events };
}

test("process capture covers every Omarchy target, forwards agent flags verbatim, and never records arguments or terminal output", (t) => {
  const box = machine(t);
  for (const agent of Object.keys(AGENT_COMMANDS)) {
    const child = box.run(agent, ["-e", 'process.stdout.write("PRIVATE_OUTPUT:" + process.argv[1]);', "--", "--help"]);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "PRIVATE_OUTPUT:--help");
    const captured = box.events().filter((event) => event.actorId === agent);
    assert.deepEqual(captured.map((event) => event.type), ["agent.process.started", "agent.process.completed"]);
    assert.equal(captured[1].payload.exit_code, 0);
    assert.equal(captured[1].payload.source, "process");
    assert.equal(captured[0].threadId, captured[1].threadId);
    assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_OUTPUT|process\.stdout|--help/);
  }
  const verified = spawnSync(process.execPath, [CLI, "verify"], { env: box.env, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
});

test("process failures preserve exit codes and opt-out still starts the agent", (t) => {
  const box = machine(t);
  const failed = box.run("kimi", ["-e", 'process.exit(7)']);
  assert.equal(failed.status, 7);
  assert.equal(box.events().at(-1).type, "agent.process.failed");
  assert.equal(box.events().at(-1).payload.exit_code, 7);
  const before = box.events().length;
  const optedOut = box.run("hermes", ["-e", 'process.stdout.write("agent still ran")'], { EVENTLOOM_DISABLE: "1" });
  assert.equal(optedOut.status, 0);
  assert.equal(optedOut.stdout, "agent still ran");
  assert.equal(box.events().length, before);
  const missing = box.run("muse", [], { PATH: path.join(box.home, "absent") });
  assert.equal(missing.status, 127);
  assert.equal(box.events().at(-1).payload.reason, "launch_failed");
});

test("process wrapper forwards termination and records the signal without hanging", async (t) => {
  const box = machine(t);
  const child = spawn(process.execPath, [CLI, "run", "ori", "--", "-e", 'process.stdout.write(String(process.pid));setInterval(()=>{},1000)'], { cwd: box.home, env: box.env, stdio: ["ignore", "pipe", "pipe"] });
  let ready = "";
  child.stdout.on("data", (chunk) => { ready += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (/^\d+$/.test(ready)) {
      try { process.kill(Number(ready), "SIGKILL"); }
      catch { /* the fixture process has already exited */ }
    }
  });
  await until(() => /^\d+$/.test(ready));
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  child.once("close", () => { ready = ""; });
  child.kill("SIGTERM");
  assert.equal(await closed, 143);
  assert.equal(box.events().at(-1).payload.reason, "SIGTERM");
});

test("agent inventory lists every target and distinguishes native and process-only coverage", (t) => {
  const box = machine(t);
  const result = spawnSync(process.execPath, [CLI, "agents", "--json"], { env: box.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const agents = JSON.parse(result.stdout);
  assert.deepEqual(agents.map((agent) => agent.agent), Object.keys(AGENT_COMMANDS));
  assert.equal(agents.filter((agent) => agent.native).length, 12);
  assert.ok(agents.every((agent) => agent.process));
  assert.equal(agents.find((agent) => agent.agent === "crush").automatic_memory, false);
});

test("a recording failure does not prevent the agent from running", async (t) => {
  useTempLogDir(t);
  const box = machine(t), recorded = [];
  const result = await runAgent("codex", ["-e", "process.exit(0)"], { env: box.env, cwd: box.home, write: async (events) => {
    recorded.push(...events);
    throw new Error("PRIVATE_FAILURE");
  } });
  assert.equal(result, 0);
  assert.equal(recorded.length, 2);
  const errors = readFileSync(path.join(path.dirname(process.env.EVENTLOOM_LOG_DIR), "eventloom-errors.log"), "utf8");
  assert.doesNotMatch(errors, /PRIVATE_FAILURE/);
});
