// OpenCode's local plugin contract. Verified against @opencode-ai/plugin
// and SDK 1.19.3 type declarations, including the legacy event projection.
import { homedir } from "node:os";
import path from "node:path";
import { adapterWriter } from "./adapter-writer.mjs";
import { recordError } from "./error-log.mjs";
import { isPlainObject } from "./shape.mjs";

// Global plugins are loaded in addition to OPENCODE_CONFIG_DIR, so one
// global file covers both cases without duplicate custom-directory copies.
export function opencodeConfigDir(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
}
export const opencodePluginPath = () => path.join(opencodeConfigDir(), "plugins/omarchy-eventloom.js");

export function createOpenCodeAdapter({ directory = process.cwd() } = {}, writer = adapterWriter("opencode")) {
  if (process.env.EVENTLOOM_DISABLE === "1") return {};
  const sessions = new Map(), calls = new Map(), turns = new Map(), briefings = new Map(), approvals = new Map();
  const report = () => recordError("opencode-adapter", "invalid or unsupported OpenCode event; recording skipped");
  const valid = (value) => typeof value === "string" && value.length > 0;
  function emit(session, type, payload = {}, at = Date.now()) {
    if (!valid(session)) return;
    writer.write({ type, actor: "opencode", thread: `opencode-${session}`, payload: {
      session_id: session, correlation_id: process.env.EVENTLOOM_CORRELATION_ID || `opencode-${session}`,
      occurred_at: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
      cwd: sessions.get(session)?.directory || directory, ...payload,
    } });
  }
  function enter(session, source = "observed", info = {}) {
    if (!valid(session)) { report(); return false; }
    if (sessions.has(session)) return true;
    sessions.set(session, { directory: typeof info.directory === "string" ? info.directory : directory });
    emit(session, source === "created" ? "agent.session.started" : "agent.session.resumed", {
      source, ...(valid(info.parentID) ? { parent_session_id: info.parentID } : {}),
    });
    return true;
  }
  function end(session, reason) {
    if (!sessions.has(session)) return;
    emit(session, "agent.session.completed", { reason });
    sessions.delete(session); turns.delete(session); briefings.delete(session);
    for (const [key, call] of calls) if (call.session === session) calls.delete(key);
    for (const [key, owner] of approvals) if (owner === session) approvals.delete(key);
  }
  function tool(session, id, name, state, args, when, metadata) {
    if (!valid(id) || !valid(name) || !enter(session)) return;
    const key = JSON.stringify([session, id]);
    const previous = calls.get(key);
    if (state === "running") {
      if (previous) return;
      calls.set(key, { session, state, at: when?.start ?? Date.now() });
      emit(session, "agent.tool.started", { tool: name, tool_use_id: id,
        ...(isPlainObject(args) ? { tool_input_keys: Object.keys(args).sort() } : {}),
      }, when?.start);
    } else if (state === "completed" || state === "error") {
      if (previous?.state === "completed" || previous?.state === "error") return;
      const started = when?.start ?? previous?.at;
      const ended = when?.end ?? Date.now();
      calls.set(key, { session, state, at: started });
      const code = isPlainObject(metadata) ? metadata.exit ?? metadata.exit_code : undefined;
      const failed = state === "error" || Number.isSafeInteger(code) && code !== 0;
      emit(session, failed ? "agent.tool.failed" : "agent.tool.completed", {
        tool: name, tool_use_id: id, outcome: failed ? "failure" : "success",
        ...(Number.isFinite(started) && ended >= started ? { duration_ms: ended - started } : {}),
        ...(Number.isSafeInteger(code) ? { exit_code: code } : {}),
      }, ended);
    }
  }
  const safe = (handler) => async (...args) => {
    if (process.env.EVENTLOOM_DISABLE === "1") return;
    try { return await handler(...args); } catch { report(); }
  };
  function dispose() {
    for (const session of [...sessions.keys()]) end(session, "server_disposed");
    writer.close();
  }
  return {
    dispose: safe(dispose),
    "chat.message": safe((input) => { enter(input.sessionID); }),
    "tool.execute.before": safe((input, output) => { tool(input.sessionID, input.callID, input.tool, "running", output.args); }),
    "experimental.chat.system.transform": safe(async (input, output) => {
      if (!valid(input.sessionID) || !Array.isArray(output.system) || !enter(input.sessionID)) return;
      if (process.env.EVENTLOOM_MEMORY === "0") return;
      if (!briefings.has(input.sessionID)) briefings.set(input.sessionID, writer.brief(input.sessionID, sessions.get(input.sessionID).directory));
      const context = await briefings.get(input.sessionID);
      if (context) output.system.push(context);
    }),
    event: safe(({ event }) => {
      const properties = event.properties ?? event.data ?? {};
      const session = properties.sessionID ?? properties.info?.id ?? properties.part?.sessionID;
      if (event.type === "session.created") enter(session, "created", properties.info);
      else if (event.type === "session.deleted") end(session, "deleted");
      else if (event.type === "session.compacted" && enter(session)) {
        briefings.delete(session);
        emit(session, "agent.session.resumed", { source: "compact" });
      } else if (event.type === "server.instance.disposed" || event.type === "global.disposed") dispose();
      else if (event.type === "message.part.updated") {
        const part = properties.part;
        if (part?.type === "tool" && !part.state?.time?.compacted) tool(part.sessionID, part.callID, part.tool, part.state?.status, part.state?.input, part.state?.time, part.state?.metadata);
      } else if (event.type === "session.status" && enter(session)) {
        if (properties.status?.type === "busy" && !turns.has(session)) {
          turns.set(session, Date.now()); emit(session, "agent.model.started");
        }
      } else if (event.type === "session.idle" && turns.has(session)) {
        emit(session, "agent.model.completed", { duration_ms: Date.now() - turns.get(session) }); turns.delete(session);
      } else if (event.type === "session.error" && turns.has(session)) {
        emit(session, "agent.model.failed", { reason: "session_error", duration_ms: Date.now() - turns.get(session) }); turns.delete(session);
      } else if (["permission.updated", "permission.asked"].includes(event.type) && enter(session)) {
        const key = JSON.stringify([session, properties.id]);
        if (approvals.has(key)) return;
        approvals.set(key, session);
        emit(session, "agent.approval.requested", {
          ...(valid(properties.id) ? { request_id: properties.id } : {}),
          ...(valid(properties.tool?.callID ?? properties.callID) ? { tool_use_id: properties.tool?.callID ?? properties.callID } : {}),
        });
      } else if (event.type === "permission.replied" && enter(session)) {
        const decision = properties.reply ?? properties.response;
        emit(session, "agent.approval.resolved", {
          ...(valid(properties.requestID ?? properties.permissionID) ? { request_id: properties.requestID ?? properties.permissionID } : {}),
          ...(decision === "reject" ? { approved: false } : ["once", "always"].includes(decision) ? { approved: true } : {}),
        });
      }
    }),
  };
}
