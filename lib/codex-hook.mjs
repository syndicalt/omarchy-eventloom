// Official Codex command-hook inputs, as documented at
// https://learn.chatgpt.com/docs/hooks (Codex CLI 0.163.0).
// No transcript, prompts, arguments or output are copied into the event.
import { isPlainObject } from "./shape.mjs";

export const CODEX_HOOK_EVENTS = [
  "SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", "PermissionRequest", "SubagentStart", "SubagentStop",
];
const RESUMING = new Set(["resume", "compact"]);

// PostToolUse also runs for failures. Only explicit structured result fields
// establish success/failure; arbitrary tool output text is not a protocol.
export function codexToolOutcome(response) {
  if (!isPlainObject(response)) return { outcome: "unknown" };
  if (response.isError === true) return { outcome: "failure" };
  const code = response.exit_code ?? response.exitCode;
  if (Number.isSafeInteger(code)) return { outcome: code === 0 ? "success" : "failure", exit_code: code };
  if (typeof response.isError === "boolean") return { outcome: response.isError ? "failure" : "success" };
  return { outcome: "unknown" };
}

export function codexHookToEvent(hook, { now = new Date(), env = process.env } = {}) {
  if (!isPlainObject(hook)) throw new Error("Codex hook input is not a JSON object");
  const name = hook.hook_event_name;
  if (!CODEX_HOOK_EVENTS.includes(name)) return null;
  if (typeof hook.session_id !== "string" || !hook.session_id) throw new Error("Codex hook input has no session_id");
  const child = name === "SubagentStart" || name === "SubagentStop";
  if (child && (typeof hook.agent_id !== "string" || !hook.agent_id)) throw new Error("Codex subagent hook input has no agent_id");
  const session = child ? hook.agent_id : hook.session_id;
  const payload = {
    session_id: session,
    correlation_id: env.EVENTLOOM_CORRELATION_ID || `codex-${hook.session_id}`,
    occurred_at: now.toISOString(),
  };
  for (const key of ["cwd", "model", "turn_id", "permission_mode"]) {
    if (typeof hook[key] === "string") payload[key] = hook[key];
  }
  let type;
  if (child) {
    type = name === "SubagentStart" ? "agent.session.started" : "agent.session.completed";
    payload.parent_session_id = hook.session_id;
    payload.source = "subagent";
    if (typeof hook.agent_type === "string") payload.agent_type = hook.agent_type;
  } else if (name === "SessionStart") {
    type = RESUMING.has(hook.source) ? "agent.session.resumed" : "agent.session.started";
    if (typeof hook.source === "string") payload.source = hook.source;
  } else if (name === "SessionEnd") {
    type = "agent.session.completed";
    if (typeof hook.reason === "string") payload.reason = hook.reason;
  } else {
    if (typeof hook.tool_name !== "string" || !hook.tool_name) throw new Error("Codex tool hook input has no tool_name");
    payload.tool = hook.tool_name;
    if (typeof hook.tool_use_id === "string") payload.tool_use_id = hook.tool_use_id;
    if (isPlainObject(hook.tool_input)) payload.tool_input_keys = Object.keys(hook.tool_input).sort();
    if (name === "PreToolUse") type = "agent.tool.started";
    else if (name === "PermissionRequest") type = "agent.approval.requested";
    else {
      Object.assign(payload, codexToolOutcome(hook.tool_response));
      type = payload.outcome === "failure" ? "agent.tool.failed" : "agent.tool.completed";
    }
  }
  return { type, actorId: "codex", threadId: `codex-${session}`, payload };
}
