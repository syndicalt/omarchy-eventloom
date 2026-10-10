// Claude hook body. The shell wrapper execs this with the hook event name and
// the hook JSON on stdin. Appends in the foreground so the write is not killed
// when the hook process exits, and reports failures on stderr without failing
// the agent (exit 0).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const event = process.argv[2] ?? "";
if (!event || process.env.EVENTLOOM_DISABLE === "1") process.exit(0);

const bin = `${homedir()}/.local/bin/eventloom`;
let raw = "";
try { raw = readFileSync(0, "utf8"); } catch { raw = ""; }
let data = {};
try { data = raw.trim() ? JSON.parse(raw) : {}; } catch { data = {}; }

const session = data.session_id || data.sessionId || "unknown";
const tool = data.tool_name || data.toolName;
const toolInput = data.tool_input || data.toolInput || {};
const response = data.tool_response ?? data.toolResponse;
let failed = Boolean(data.error || data.is_error || data.isError || data.tool_error);
let exitCode;
if (response && typeof response === "object") {
  if (response.is_error || response.isError || response.error) failed = true;
  const code = response.exit_code ?? response.exitCode;
  if (typeof code === "number" && code !== 0) {
    failed = true;
    exitCode = code;
  }
}

const payload = { session_id: session };
if (data.cwd) payload.cwd = data.cwd;
const hookEvent = data.hook_event_name || data.hookEventName;
if (hookEvent) payload.hook_event = hookEvent;
if (tool) payload.tool = tool;
if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
  payload.tool_input_keys = Object.keys(toolInput).sort();
}
if (failed) payload.exit_code = exitCode ?? 1;

let type;
if (event === "session_start") type = "agent.session.started";
else if (event === "session_stop") type = "agent.session.completed";
else if (event === "post_tool") type = failed ? "agent.tool.failed" : "agent.tool.completed";
else process.exit(0);

const args = ["append", type, "--actor", "claude", "--thread", `claude-${session}`, "--payload", JSON.stringify(payload)];
if (data.cwd) args.push("--cwd", String(data.cwd));
const result = spawnSync(bin, args, { encoding: "utf8", timeout: 8000 });
if (result.error || result.status) {
  const detail = (result.stderr || result.error?.message || "append failed").trim();
  console.error(`eventloom: ${detail}`);
}
process.exit(0);
