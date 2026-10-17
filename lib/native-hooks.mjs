// Native command-hook contracts. Keep each agent's field names and lifecycle
// semantics explicit: similar hook names do not imply the same wire protocol.
import { homedir } from "node:os";
import path from "node:path";
import { isPlainObject } from "./shape.mjs";
import { hookCommand } from "./claude-settings.mjs";
import { codexToolOutcome } from "./codex-hook.mjs";

export const NATIVE_HOOKS = {
  copilot: {
    events: ["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop"],
    shape: "flat", memory: "copilot",
    home: (env) => env.COPILOT_HOME || path.join(homedir(), ".copilot"),
    config: "hooks/omarchy-eventloom.json",
    reference: "https://docs.github.com/en/copilot/reference/hooks-reference",
  },
  gemini: {
    events: ["SessionStart", "SessionEnd", "BeforeTool", "AfterTool", "BeforeAgent", "AfterAgent"],
    shape: "grouped", memory: "gemini",
    home: () => path.join(homedir(), ".gemini"), config: "settings.json",
    reference: "https://geminicli.com/docs/hooks/reference/",
  },
  crush: {
    // Crush currently exposes only top-level pre-tool observations.
    events: ["PreToolUse"], shape: "flat", memory: null,
    home: (env) => path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "crush"),
    config: "crush.json",
    reference: "https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md",
  },
  grok: {
    events: ["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop", "StopFailure", "StopCancelled"],
    shape: "grouped", memory: null, // SessionStart stdout is ignored by Grok.
    home: (env) => env.GROK_HOME || path.join(homedir(), ".grok"),
    config: "hooks/omarchy-eventloom.json",
    reference: "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md",
  },
  agy: {
    events: ["SessionStart", "PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation"],
    // Stop terminates the execution loop, not the conversation. There is no
    // documented session-end hook, so we do not synthesize one from Stop.
    shape: "named", memory: "agy",
    home: () => path.join(homedir(), ".gemini", "antigravity-cli"),
    config: "../config/hooks.json",
    reference: "https://antigravity.google/docs/hooks",
  },
  muse: {
    events: ["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop", "StopFailure"],
    shape: "grouped", memory: "muse",
    home: (env) => path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "muse"),
    config: "settings.json",
    reference: "https://meta-models.github.io/muse-code-sdk/next/guides/plugins/reference/hook-events/",
  },
  "cursor-agent": {
    // Cursor CLI has historically exposed fewer hooks than the editor. The
    // shell completion hook is the shared, documented CLI surface. Do not
    // claim editor-only lifecycles or feed a permission gate for observation.
    events: ["afterShellExecution"], shape: "flat", memory: null,
    home: () => path.join(homedir(), ".cursor"), config: "hooks.json",
    reference: "https://cursor.com/docs/hooks",
  },
};

export function nativeHookPaths(agent, env = process.env) {
  const profile = NATIVE_HOOKS[agent];
  if (!profile) throw new Error("Unknown native hook agent");
  const home = profile.home(env);
  return { home, config: path.resolve(home, profile.config), script: path.join(homedir(), ".local/share/eventloom/hooks/eventloom-native-hook.sh") };
}

function commandFor(agent, event, script) {
  return `${hookCommand(script)} ${agent} ${event}`;
}
// Match only commands we generate, including an older installation path.
const OWN_COMMAND = /^sh '(?:[^']|'\\'')*\/eventloom-native-hook\.sh' (copilot|gemini|crush|grok|agy|muse|cursor-agent) ([A-Za-z]+)$/;
function own(hook, agent) {
  const match = OWN_COMMAND.exec(hook?.command ?? hook?.bash ?? "");
  return match?.[1] === agent;
}

function tableOf(settings, agent) {
  const profile = NATIVE_HOOKS[agent];
  const table = profile.shape === "named" ? settings["omarchy-eventloom"] ?? {} : settings.hooks ?? {};
  if (!isPlainObject(table)) throw new Error(`${agent} hook table is not an object; left unchanged`);
  for (const [event, entries] of Object.entries(table)) {
    if (event === "enabled" && profile.shape === "named" && typeof entries === "boolean") continue;
    if (event === "state" && agent === "muse" && isPlainObject(entries)) continue;
    if (!Array.isArray(entries)) throw new Error(`${agent} hook event is not a list; left unchanged`);
    for (const entry of entries) {
      const grouped = profile.shape === "grouped" || profile.shape === "named" && ["PreToolUse", "PostToolUse"].includes(event);
      if (!isPlainObject(entry) || grouped && !Array.isArray(entry.hooks)) throw new Error(`${agent} hook entry has an invalid shape; left unchanged`);
      for (const handler of grouped ? entry.hooks : [entry]) {
        if (!isPlainObject(handler)) throw new Error(`${agent} hook handler is not an object; left unchanged`);
      }
    }
  }
  return table;
}

export function unwireNativeHooks(settings, agent) {
  const profile = NATIVE_HOOKS[agent];
  if (!profile) throw new Error("Unknown native hook agent");
  const next = structuredClone(settings), table = tableOf(next, agent);
  let removed = 0;
  for (const [event, entries] of Object.entries(table)) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      if (Array.isArray(entry.hooks)) {
        const others = entry.hooks.filter((handler) => !own(handler, agent));
        removed += entry.hooks.length - others.length;
        if (others.length === entry.hooks.length) kept.push(entry);
        else if (others.length) kept.push({ ...entry, hooks: others });
      } else if (own(entry, agent)) removed++;
      else kept.push(entry);
    }
    if (kept.length !== entries.length || kept.some((entry, i) => entry !== entries[i])) {
      if (kept.length) table[event] = kept;
      else delete table[event];
    }
  }
  if (removed && !Object.keys(table).length) delete next[profile.shape === "named" ? "omarchy-eventloom" : "hooks"];
  // Dedicated hook files remain valid after our last handler is removed.
  if (removed && ["copilot", "grok"].includes(agent)) next.hooks ??= {};
  return { settings: next, removed };
}

export function wireNativeHooks(settings, agent, script = nativeHookPaths(agent).script) {
  const profile = NATIVE_HOOKS[agent];
  const { settings: next, removed } = unwireNativeHooks(settings, agent);
  // The named Antigravity namespace must belong to this adapter before we
  // add to it. Do not commandeer a user's unrelated hook with the same name.
  if (profile.shape === "named" && settings["omarchy-eventloom"] && !removed) throw new Error("Antigravity hook name omarchy-eventloom is already in use; left unchanged");
  const table = next[profile.shape === "named" ? "omarchy-eventloom" : "hooks"] ??= {};
  if (agent === "copilot" || agent === "cursor-agent") {
    if (next.version !== undefined && next.version !== 1) throw new Error("Unsupported Copilot hook version; left unchanged");
    next.version = 1;
  }
  if (agent === "muse") {
    if (next.schema_version !== undefined && next.schema_version !== 1) throw new Error("Unsupported Muse settings version; left unchanged");
    next.schema_version = 1;
  }
  for (const event of profile.events) {
    const command = commandFor(agent, event, script);
    const handler = agent === "copilot" ? { type: "command", bash: command, timeoutSec: 15 }
      : agent === "crush" || agent === "cursor-agent" ? { command }
        : { type: "command", command, timeout: agent === "gemini" ? 15000 : 15 };
    const grouped = profile.shape === "grouped" || profile.shape === "named" && ["PreToolUse", "PostToolUse"].includes(event);
    (table[event] ??= []).push(grouped ? { hooks: [handler] } : handler);
  }
  return next;
}

export function missingNativeHooks(settings, agent, script = nativeHookPaths(agent).script) {
  const table = tableOf(settings, agent);
  if (table.enabled === false) return NATIVE_HOOKS[agent].events;
  return NATIVE_HOOKS[agent].events.filter((event) => !(table[event] ?? []).some((entry) => {
    if (entry.enabled === false || entry.matcher !== undefined && entry.matcher !== "" && entry.matcher !== ".*") return false;
    return (entry.hooks ?? [entry]).some((handler) => handler.enabled !== false && (handler.command ?? handler.bash) === commandFor(agent, event, script));
  }));
}

export function nativeHookToEvent(agent, event, hook, { now = new Date(), env = process.env } = {}) {
  const profile = NATIVE_HOOKS[agent];
  if (!profile || !profile.events.includes(event)) throw new Error("Unsupported native hook event");
  if (!isPlainObject(hook)) throw new Error("Native hook input is not a JSON object");
  // Antigravity sends no event-name field. Its configured command supplies it.
  const session = agent === "agy" ? hook.conversationId : agent === "grok" ? hook.sessionId : agent === "cursor-agent" ? hook.conversation_id : hook.session_id;
  if (typeof session !== "string" || !session) throw new Error("Native hook input has no session identifier");
  const payload = { session_id: session, correlation_id: env.EVENTLOOM_CORRELATION_ID || `${agent}-${session}`, occurred_at: now.toISOString() };
  const cwd = agent === "agy" ? hook.workspacePaths?.[0] : hook.cwd;
  if (typeof cwd === "string") payload.cwd = cwd;
  const model = agent === "agy" ? hook.modelName : hook.model;
  if (typeof model === "string") payload.model = model;
  let type;
  if (event === "SessionStart") {
    type = ["resume", "compact"].includes(hook.source) ? "agent.session.resumed" : "agent.session.started";
    if (["startup", "resume", "new", "clear"].includes(hook.source)) payload.source = hook.source;
  } else if (event === "SessionEnd") {
    type = "agent.session.completed";
    if (["exit", "clear", "logout", "prompt_input_exit", "other", "complete", "error", "abort", "timeout", "user_exit"].includes(hook.reason)) payload.reason = hook.reason;
  } else if (["BeforeAgent", "UserPromptSubmit", "PreInvocation"].includes(event)) type = "agent.model.started";
  else if (["AfterAgent", "Stop", "PostInvocation"].includes(event)) type = "agent.model.completed";
  else if (["StopFailure", "StopCancelled"].includes(event)) type = "agent.model.failed";
  else {
    const tool = agent === "agy" ? hook.toolCall?.name : agent === "grok" ? hook.toolName : agent === "cursor-agent" ? "Shell" : hook.tool_name;
    const input = agent === "agy" ? hook.toolCall?.args : agent === "grok" ? hook.toolInput : hook.tool_input;
    if (typeof tool !== "string" || !tool) throw new Error("Native tool hook input has no tool name");
    payload.tool = tool;
    if (isPlainObject(input)) payload.tool_input_keys = Object.keys(input).sort();
    if (agent === "grok" && typeof hook.toolUseId === "string") payload.tool_use_id = hook.toolUseId;
    if (agent === "muse" && typeof hook.tool_use_id === "string") payload.tool_use_id = hook.tool_use_id;
    if (agent === "cursor-agent") {
      payload.tool_input_keys = ["command"];
      if (Number.isFinite(hook.duration) && hook.duration >= 0) payload.duration_ms = hook.duration;
    }
    // stepIdx identifies the executed trajectory step, not necessarily a
    // stable pre/post call pair, so it is deliberately not a tool_use_id.
    if (["PreToolUse", "BeforeTool"].includes(event)) type = "agent.tool.started";
    else {
      if (event === "PostToolUseFailure") payload.outcome = "failure";
      else if (agent === "agy") payload.outcome = hook.error ? "failure" : "success";
      else if (agent === "gemini") payload.outcome = hook.tool_response?.error ? "failure" : "success";
      else if (agent === "grok") Object.assign(payload, codexToolOutcome(hook.toolResult));
      else if (agent === "cursor-agent") payload.outcome = "unknown"; // stdout has no structured status.
      else payload.outcome = "success"; // Copilot uses a separate failure event.
      type = payload.outcome === "failure" ? "agent.tool.failed" : "agent.tool.completed";
    }
  }
  if (agent === "grok" && typeof hook.promptId === "string") payload.turn_id = hook.promptId;
  if (agent === "muse" && typeof hook.turn_id === "string") payload.turn_id = hook.turn_id;
  return { type, actorId: agent, threadId: `${agent}-${session}`, payload };
}

export function nativeHookResponse(agent, event, context) {
  // Antigravity requires a decision on PreToolUse. Its documented "allow"
  // delegates to remaining hooks/default policy; "auto_approve" bypasses the
  // prompt. We never return auto_approve, overrides or rewritten arguments.
  if (agent === "agy" && event === "PreToolUse") return { decision: "allow" };
  if (event !== "SessionStart" || !context) return {};
  if (agent === "copilot") return { additionalContext: context };
  if (agent === "gemini" || agent === "muse") return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
  if (agent === "agy") return { injectSteps: [{ systemMessage: { systemMessage: context } }] };
  return {};
}
