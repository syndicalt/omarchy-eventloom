// Pi 0.73.1's native extension events. Session replacement reloads extensions;
// shutdown and a new session_start are distinct from a model turn ending.
import { homedir } from "node:os";
import path from "node:path";
import { adapterWriter } from "./adapter-writer.mjs";
import { recordError } from "./error-log.mjs";
import { isPlainObject } from "./shape.mjs";

export function piAgentDir(env = process.env) {
  const value = env.PI_CODING_AGENT_DIR;
  if (!value) return path.join(homedir(), ".pi/agent");
  if (value === "~") return homedir();
  return path.resolve(value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value);
}
export const piExtensionPath = () => path.join(piAgentDir(), "extensions/omarchy-eventloom.js");

export function createPiAdapter(pi, writer = adapterWriter("pi")) {
  if (process.env.EVENTLOOM_DISABLE === "1") return;
  let session, cwd, turn;
  const calls = new Map(), briefed = new Set();
  const report = () => recordError("pi-adapter", "invalid or unsupported Pi event; recording skipped");
  function emit(type, payload = {}) {
    if (!session) return;
    writer.write({ type, actor: "pi", thread: `pi-${session}`, payload: {
      session_id: session, correlation_id: process.env.EVENTLOOM_CORRELATION_ID || `pi-${session}`,
      occurred_at: new Date().toISOString(), cwd, ...payload,
    } });
  }
  function close(reason) {
    if (!session) return;
    emit("agent.session.completed", { reason });
    briefed.delete(session); calls.clear(); session = undefined; turn = undefined;
  }
  function enter(ctx, source = "observed") {
    const current = ctx?.sessionManager?.getSessionId?.();
    if (typeof current !== "string" || !current) { report(); return false; }
    if (session === current) return true;
    close("switch");
    session = current; cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
    emit(["resume", "reload", "observed"].includes(source) ? "agent.session.resumed" : "agent.session.started", { source });
    return true;
  }
  const safe = (handler) => async (...args) => {
    if (process.env.EVENTLOOM_DISABLE === "1") return;
    try { return await handler(...args); } catch { report(); }
  };
  pi.on("session_start", safe((event, ctx) => { enter(ctx, ["startup", "reload", "new", "resume", "fork"].includes(event.reason) ? event.reason : "startup"); }));
  pi.on("session_shutdown", safe((event) => { close(["quit", "reload", "new", "resume", "fork"].includes(event.reason) ? event.reason : "shutdown"); writer.close(); }));
  for (const [event, source] of [["session_tree", "tree"], ["session_compact", "compact"]]) {
    pi.on(event, safe((_event, ctx) => {
      if (!enter(ctx)) return;
      briefed.delete(session); emit("agent.session.resumed", { source });
    }));
  }
  pi.on("before_agent_start", safe(async (_event, ctx) => {
    if (!enter(ctx) || briefed.has(session) || process.env.EVENTLOOM_MEMORY === "0") return;
    briefed.add(session);
    const content = await writer.brief(session, cwd);
    return content ? { message: { customType: "eventloom-memory", content, display: false } } : undefined;
  }));
  pi.on("agent_start", safe((_event, ctx) => {
    if (!enter(ctx)) return;
    turn = Date.now(); emit("agent.model.started", { model: typeof ctx.model?.id === "string" ? ctx.model.id : undefined });
  }));
  pi.on("agent_end", safe((_event, ctx) => {
    if (!session || turn === undefined) return;
    emit("agent.model.completed", { model: typeof ctx.model?.id === "string" ? ctx.model.id : undefined, duration_ms: Date.now() - turn }); turn = undefined;
  }));
  pi.on("message_end", safe((event) => {
    const reason = event.message?.stopReason;
    if (turn === undefined || event.message?.role !== "assistant" || !["error", "aborted"].includes(reason)) return;
    emit("agent.model.failed", { reason, duration_ms: Date.now() - turn }); turn = undefined;
  }));
  pi.on("tool_execution_start", safe((event, ctx) => {
    if (!enter(ctx) || typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
    calls.set(event.toolCallId, Date.now());
    emit("agent.tool.started", { tool: event.toolName, tool_use_id: event.toolCallId,
      ...(isPlainObject(event.args) ? { tool_input_keys: Object.keys(event.args).sort() } : {}),
    });
  }));
  pi.on("tool_execution_end", safe((event, ctx) => {
    if (!enter(ctx) || typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
    const start = calls.get(event.toolCallId); calls.delete(event.toolCallId);
    emit(event.isError ? "agent.tool.failed" : "agent.tool.completed", {
      tool: event.toolName, tool_use_id: event.toolCallId,
      outcome: typeof event.isError === "boolean" ? event.isError ? "failure" : "success" : "unknown",
      ...(start !== undefined ? { duration_ms: Date.now() - start } : {}),
    });
  }));
}
