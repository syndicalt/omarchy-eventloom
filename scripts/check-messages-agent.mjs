// Optional native Claude/omp check. Disposable HOME; loopback Messages fixture;
// fixed tool commands; no real account or model requests.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wireClaudeHooks } from "../lib/claude-settings.mjs";
const repo = fileURLToPath(new URL("..", import.meta.url));
const agent = process.argv[2] || "claude";
assert.ok(["claude", "omp"].includes(agent), "Choose claude or omp");
const binary = spawnSync("sh", ["-c", `command -v ${agent}`], { encoding: "utf8" }).stdout.trim();
assert.ok(binary, `An installed ${agent} CLI is required`);
const fd = openSync(binary, "r"), buffer = Buffer.alloc(4096);
let header;
try { header = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0)); }
finally { closeSync(fd); }
assert.ok(!header.startsWith("#!") || !header.includes("mise use -g"), `Install ${agent} before running this check`);
const root = mkdtempSync(path.join(tmpdir(), `eventloom-native-${agent}-`));
let phase = 0, sawBriefing = false, fixtureError;
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":100}'); return; }
    sawBriefing ||= JSON.stringify(request).includes("Eventloom keeps a memory");
    const toolName = request.tools?.find((tool) => agent === "claude" ? tool.name === "Bash" : ["bash", "_bash"].includes(tool.name))?.name;
    const tools = !!toolName;
    const tool = tools && phase < 2;
    const content = tool ? { type: "tool_use", id: `tool_${phase}`, name: toolName, input: { command: phase++ === 0 ? "printf eventloom-native-probe" : "exit 7", description: "fixture command" } }
      : { type: "text", text: "Native fixture final response." };
    const message = { id: `msg_${phase}`, type: "message", role: "assistant", model: request.model, content: [content], stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
    if (!request.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("message_start", { message: { ...message, content: [], stop_reason: null } });
    emit("content_block_start", { index: 0, content_block: tool ? { ...content, input: {} } : { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) } : { type: "text_delta", text: content.text } });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
    emit("message_stop", {}); res.end();
  } catch (error) { fixtureError = error; res.writeHead(500); res.end(); }
});
try {
  for (const dir of [".claude/hooks", ".omp/agent/extensions", ".local/bin", ".local/lib", "work"]) mkdirSync(path.join(root, dir), { recursive: true });
  symlinkSync(repo, path.join(root, ".local/lib/eventloom"));
  copyFileSync(path.join(repo, "bin/eventloom"), path.join(root, ".local/bin/eventloom"));
  const hook = path.join(root, ".claude/hooks/eventloom-hook.sh");
  copyFileSync(path.join(repo, "hooks/eventloom-hook.sh"), hook);
  writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify(wireClaudeHooks({}, hook)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { HOME: root, PATH: process.env.PATH, ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", EVENTLOOM_LOG_DIR: path.join(root, "logs"), EVENTLOOM_MEMORY: "1" };
  if (agent === "omp") {
    copyFileSync(path.join(repo, "extensions/eventloom.ts"), path.join(root, ".omp/agent/extensions/eventloom.ts"));
    writeFileSync(path.join(root, ".omp/agent/models.yml"), `providers:\n  fixture:\n    baseUrl: http://127.0.0.1:${server.address().port}\n    apiKey: fixture-key\n    api: anthropic-messages\n    models:\n      - id: fixture\n        name: Fixture\n        contextWindow: 128000\n        maxTokens: 8192\n`);
  }
  const args = agent === "omp" ? ["--print", "--model", "fixture/fixture", "--no-extensions", "--extension", path.join(root, ".omp/agent/extensions/eventloom.ts"), "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--auto-approve", "--tools", "bash", "--thinking", "off", "Run the local fixture."] : ["-p", "Run the local fixture.", "--model", "sonnet", "--tools", "Bash", "--allowedTools", "Bash(printf eventloom-native-probe)", "Bash(exit 7)"];
  const child = spawn(binary, args, { cwd: path.join(root, "work"), env });
  child.stdin.end(); child.stdout.resume();
  let diagnostic = ""; child.stderr.on("data", (chunk) => { diagnostic += chunk; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, diagnostic);
    if (fixtureError) throw fixtureError;
    assert.equal(phase, 2, `${agent} did not execute both fixture tools`);
    assert.ok(sawBriefing, "opted-in memory did not reach the native request");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(env.EVENTLOOM_LOG_DIR) && readdirSync(env.EVENTLOOM_LOG_DIR).filter((file) => file.endsWith(".jsonl")).some((file) => readFileSync(path.join(env.EVENTLOOM_LOG_DIR, file), "utf8").includes("agent.session.completed"))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const recorded = readdirSync(env.EVENTLOOM_LOG_DIR).filter((file) => file.endsWith(".jsonl")).flatMap((file) => readFileSync(path.join(env.EVENTLOOM_LOG_DIR, file), "utf8").trim().split("\n").map(JSON.parse));
    const events = recorded.filter((event) => event.actorId === agent);
    assert.ok(events.some((event) => event.type === "agent.session.started"));
    assert.ok(events.some((event) => event.type === "agent.session.completed"));
    assert.ok(events.some((event) => event.type === "agent.tool.completed"));
    assert.ok(events.some((event) => event.type === "agent.tool.failed"));
    if (agent === "omp") assert.ok(events.filter((event) => event.type.startsWith("agent.tool.")).every((event) => typeof event.payload.tool_use_id === "string"), "native parallel tool IDs were lost");
    assert.doesNotMatch(JSON.stringify(events), /eventloom-native-probe|Native fixture final response/);
    const check = spawnSync(process.execPath, [path.join(repo, "lib/eventloom.mjs"), "verify"], { env, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    console.log(`${agent} native smoke passed: session boundaries, successful/failed tools, opted-in memory, privacy and chain integrity. Model requests used the loopback fixture.`);
  } finally { clearTimeout(timeout); }
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
