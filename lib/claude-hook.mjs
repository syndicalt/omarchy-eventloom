// Translates one Claude Code hook invocation into an eventloom event.
// Field names follow Claude Code's hook input: session_id, cwd,
// hook_event_name, tool_name, tool_input, and source / reason on the session
// hooks. test/fixtures/claude-hooks.json holds one representative input each.

import { isPlainObject } from "./shape.mjs";

// Claude fires `Stop` after every reply, so it is not a session boundary;
// `SessionEnd` is. A SessionStart whose source is "resume" or "compact"
// reopens earlier work, so it is logged as a resume and not a new start.
const RESUMING_SOURCES = new Set(["resume", "compact"]);

export const CLAUDE_HOOK_EVENTS = ["SessionStart", "SessionEnd", "PostToolUse", "PostToolUseFailure"];

function eventType(hook) {
  switch (hook.hook_event_name) {
    case "SessionStart":
      return RESUMING_SOURCES.has(hook.source) ? "agent.session.resumed" : "agent.session.started";
    case "SessionEnd":
      return "agent.session.completed";
    case "PostToolUse":
      return "agent.tool.completed";
    case "PostToolUseFailure":
      return "agent.tool.failed";
    default:
      return null;
  }
}

// Returns an event draft, or null for hooks eventloom does not record.
// Throws when the input cannot be attributed to a session.
export function claudeHookToEvent(hook, { now = new Date(), env = process.env } = {}) {
  if (!isPlainObject(hook)) throw new Error("hook input is not a JSON object");
  const type = eventType(hook);
  if (type === null) return null;
  if (typeof hook.session_id !== "string" || hook.session_id === "") {
    throw new Error(`${hook.hook_event_name} hook input has no session_id`);
  }

  const payload = {
    session_id: hook.session_id,
    correlation_id: env.EVENTLOOM_CORRELATION_ID || `claude-${hook.session_id}`,
    occurred_at: now.toISOString(),
  };
  if (typeof hook.cwd === "string") payload.cwd = hook.cwd;
  if (typeof hook.source === "string") payload.source = hook.source;
  if (typeof hook.reason === "string") payload.reason = hook.reason;
  if (typeof hook.tool_name === "string") payload.tool = hook.tool_name;
  // Argument names say what kind of call it was without quoting its content.
  if (isPlainObject(hook.tool_input)) payload.tool_input_keys = Object.keys(hook.tool_input).sort();

  return { type, actorId: "claude", threadId: `claude-${hook.session_id}`, payload };
}
