// Optional native smoke test: npm run check:codex (requires installed Codex).
// Runs only disposable hooks and fixed shell commands against a loopback
// Responses fixture. No real model, account, transcript or user config is used.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { accessSync, closeSync, constants, copyFileSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wireCodexHooks } from "../lib/codex-settings.mjs";

// Omarchy's cold launchers install an agent on first invocation. A native
// test must require an existing installation instead of triggering a download.
function codexBinary() {
  const wanted = process.env.EVENTLOOM_CODEX_BIN || "codex";
  const candidates = wanted.includes(path.sep) ? [path.resolve(wanted)]
    : (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, wanted));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); } catch { continue; }
    const fd = openSync(candidate, "r");
    let header;
    try {
      const buffer = Buffer.alloc(4096);
      header = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally { closeSync(fd); }
    if (header.startsWith("#!") && header.includes("mise use -g")) {
      throw new Error("Codex is an Omarchy lazy launcher. Install Codex first, or set EVENTLOOM_CODEX_BIN to its installed executable.");
    }
    return candidate;
  }
  throw new Error("An installed Codex CLI is required for check:codex");
}
const codex = codexBinary();
const repo = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "eventloom-native-codex-"));
const env = { HOME: root, CODEX_HOME: path.join(root, ".codex"), PATH: process.env.PATH,
  EVENTLOOM_LOG_DIR: path.join(root, "logs") };
let requests = 0, phase = 0, sawBriefing = false, fixtureError;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    if (phase === 1 && JSON.stringify(request.input).includes("Native memory marker")) sawBriefing = true;
    const names = (request.tools ?? []).map((tool) => tool.name ?? tool.type);
    const n = requests++ % 3;
    let item;
    if (n < 2) {
      const name = names.includes("exec_command") ? "exec_command" : names.includes("shell_command") ? "shell_command" : null;
      assert.ok(name, "Codex did not offer a shell tool to the local fixture");
      const command = n === 0 ? "printf eventloom-native-probe" : "exit 7";
      const args = name === "exec_command" ? { cmd: command, yield_time_ms: 1000 } : { command };
      item = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args), status: "completed" };
    } else {
      item = { type: "message", id: "msg_1", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Probe complete.", annotations: [] }] };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const response = { id: `resp_${requests}`, object: "response", created_at: Math.floor(Date.now() / 1000), model: "fixture", status: "in_progress", output: [] };
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("response.created", { response });
    emit("response.output_item.added", { output_index: 0, item });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", { response: { ...response, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
    res.end();
  } catch (error) {
    fixtureError = error;
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
const cli = (args, input = "") => {
  const result = spawnSync(process.execPath, [path.join(repo, "lib/eventloom.mjs"), ...args], { env, input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
async function nativeSession() {
  const child = spawn(codex, [
    // Trust bypass applies only to fixture definitions created below, never
    // to the user's installation. Production registration retains /hooks review.
    "--no-daemon", "--dangerously-bypass-hook-trust", "exec", "--json", "--skip-git-repo-check",
    "-C", path.join(root, "work"), "-s", "danger-full-access", "Run the local probe.",
  ], { env });
  child.stdin.end();
  child.stdout.resume();
  let diagnostic = "";
  child.stderr.on("data", (chunk) => { diagnostic += chunk; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, diagnostic);
    if (fixtureError) throw fixtureError;
  } finally { clearTimeout(timeout); }
}
try {
  for (const dir of [".codex/hooks", ".local/bin", ".local/lib", "work"]) mkdirSync(path.join(root, dir), { recursive: true });
  symlinkSync(repo, path.join(root, ".local/lib/eventloom"));
  copyFileSync(path.join(repo, "bin/eventloom"), path.join(root, ".local/bin/eventloom"));
  const hook = path.join(root, ".codex/hooks/eventloom-codex-hook.sh");
  copyFileSync(path.join(repo, "hooks/eventloom-codex-hook.sh"), hook);
  writeFileSync(path.join(root, ".codex/hooks.json"), JSON.stringify(wireCodexHooks({}, hook)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(path.join(root, ".codex/config.toml"), `model = "fixture"
model_provider = "fixture"
[model_providers.fixture]
name = "Local fixture"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
[feedback]
enabled = false
`);
  await nativeSession();
  const events = cli(["tail", "--limit", "50", "--actor", "codex"]).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((e) => e.type), ["agent.session.started", "agent.tool.started", "agent.tool.completed", "agent.tool.started", "agent.tool.completed", "agent.session.completed"]);
  assert.equal(events[1].payload.tool_use_id, events[2].payload.tool_use_id);
  assert.equal(events[3].payload.tool_use_id, events[4].payload.tool_use_id);
  // Current Codex supplies just stdout, including an empty string for `exit 7`.
  // Reporting unknown is essential: there is no structured exit status to trust.
  assert.ok(events.filter((e) => e.type === "agent.tool.completed").every((e) => e.payload.outcome === "unknown"));
  assert.doesNotMatch(JSON.stringify(events), /eventloom-native-probe|transcript_path|tool_response/);
  cli(["note", "--actor", "claude", "--session", "earlier", "--cwd", path.join(root, "work")], "Native memory marker: prepared the rollout.");
  cli(["config", "set", "memory", "on"]);
  phase = 1;
  await nativeSession();
  assert.ok(sawBriefing, "Codex did not deliver the opted-in briefing to its model request");
  assert.equal(requests, 6);
  assert.ok(JSON.parse(cli(["verify"])).ok);
  console.log("Codex native smoke test passed: sessions, tool IDs, unknown outcomes, privacy, shared memory, and chain integrity. All model requests used the loopback fixture.");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
