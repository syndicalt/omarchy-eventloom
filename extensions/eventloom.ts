// eventloom omp adapter — captures omp session lifecycle, tool calls, approvals,
// and model events into the Omarchy universal agent log (eventloom hash chain).
// Installed beside the herdr extension; follows the same plugin interface.
// @ts-nocheck

import { spawn } from "node:child_process";

const HOME = process.env.HOME ?? "";
const EVENTLOOM = `${HOME}/.local/bin/eventloom`;

function enabled() {
  return HOME !== "" && process.env.EVENTLOOM_DISABLE !== "1";
}

function cwdOf(ctx) {
  return ctx?.cwd ?? ctx?.session?.cwd ?? process.cwd();
}

function sessionIdOf(ctx) {
  const id = ctx?.sessionId ?? ctx?.session?.id;
  return id == null ? undefined : String(id);
}

// Detached so a session_shutdown append survives omp exiting. Spawn errors
// are reported; the agent path itself never waits on the log.
function append(type, payload, { thread, cwd } = {}) {
  const args = ["append", type, "--actor", "omp", "--thread", thread, "--payload", JSON.stringify(payload)];
  if (payload.correlation_id) args.push("--correlation", String(payload.correlation_id));
  if (cwd) args.push("--cwd", String(cwd));
  const child = spawn(EVENTLOOM, args, { detached: true, stdio: ["ignore", "ignore", "inherit"] });
  child.on("error", (err) => console.error("eventloom:", err.message));
  child.unref();
}

export default function (pi) {
  if (!enabled()) return;

  let sessionKey = undefined;
  let correlationId = undefined;

  function thread() {
    return `omp-${sessionKey ?? "main"}`;
  }

  function openSession(ctx, reason, resumed) {
    const incoming = sessionIdOf(ctx);
    if (sessionKey !== undefined && (!incoming || incoming === sessionKey)) return;
    sessionKey = incoming ?? `${Date.now()}`;
    correlationId = `omp-${sessionKey}`;
    append(resumed ? "agent.session.resumed" : "agent.session.started", {
      session_id: sessionKey,
      correlation_id: correlationId,
      cwd: cwdOf(ctx),
      reason,
    }, { thread: thread(), cwd: cwdOf(ctx) });
  }

  function eventPayload(ctx, extra) {
    return {
      session_id: sessionKey,
      correlation_id: correlationId,
      cwd: cwdOf(ctx),
      ...extra,
    };
  }

  pi.on("session_start", (_event, ctx) => openSession(ctx, "start", false));

  pi.on("session_switch", (event, ctx) => {
    const incoming = sessionIdOf(ctx);
    if (incoming && incoming === sessionKey) return;
    sessionKey = undefined;
    openSession(ctx, event?.reason ?? "switch", true);
  });

  pi.on("agent_start", (_event, ctx) => {
    // A turn is not a session boundary. Open lazily only if nothing has started.
    openSession(ctx, "agent_start", false);
    const model = ctx?.model ?? ctx?.session?.model;
    if (model) {
      append("agent.model.started", eventPayload(ctx, { model }), { thread: thread(), cwd: cwdOf(ctx) });
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    openSession(ctx, "tool", false);
    append("agent.tool.started", eventPayload(ctx, {
      tool: event?.toolName,
      args_summary: typeof event?.args === "object" && event?.args ? Object.keys(event.args) : undefined,
    }), { thread: thread(), cwd: cwdOf(ctx) });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    openSession(ctx, "tool", false);
    const failed = event?.isError ?? event?.error != null;
    append(failed ? "agent.tool.failed" : "agent.tool.completed", eventPayload(ctx, {
      tool: event?.toolName,
      exit_code: event?.exitCode,
      duration_ms: event?.durationMs,
    }), { thread: thread(), cwd: cwdOf(ctx) });
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    openSession(ctx, "approval", false);
    append("agent.approval.requested", eventPayload(ctx, {
      tool: event?.toolName,
      reason: event?.reason,
    }), { thread: thread(), cwd: cwdOf(ctx) });
  });

  pi.on("tool_approval_resolved", (event, ctx) => {
    openSession(ctx, "approval", false);
    append("agent.approval.resolved", eventPayload(ctx, {
      tool: event?.toolName,
      decision: event?.decision ?? event?.approved,
    }), { thread: thread(), cwd: cwdOf(ctx) });
  });

  pi.on("agent_end", (event, ctx) => {
    // The turn ended. The session stays open until session_shutdown.
    const model = ctx?.model ?? ctx?.session?.model ?? event?.model;
    if (model || event?.durationMs != null) {
      append("agent.model.completed", eventPayload(ctx, {
        model,
        duration_ms: event?.durationMs,
        failed: Boolean(event?.isError ?? event?.error != null),
      }), { thread: thread(), cwd: cwdOf(ctx) });
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (sessionKey === undefined) return;
    append("agent.session.completed", eventPayload(ctx, { reason: "shutdown" }), { thread: thread(), cwd: cwdOf(ctx) });
    sessionKey = undefined;
    correlationId = undefined;
  });
}
