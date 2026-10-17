// Process-level fallback. This observes process boundaries only; native
// adapters retain their own session IDs and link through correlation_id.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { AGENT_COMMANDS } from "./agents.mjs";
import { recordEvents } from "./record.mjs";
import { recordError } from "./error-log.mjs";

export async function runAgent(agent, args, { env = process.env, cwd = process.cwd(), write = recordEvents } = {}) {
  const command = Object.hasOwn(AGENT_COMMANDS, agent) ? AGENT_COMMANDS[agent] : null;
  if (!command) throw new Error(`run requires an Omarchy agent name: ${Object.keys(AGENT_COMMANDS).join(", ")}`);
  const session = `process-${randomUUID()}`;
  const correlation = env.EVENTLOOM_CORRELATION_ID || `${agent}-${session}`;
  const started = performance.now();
  const emit = async (type, extra = {}) => {
    if (env.EVENTLOOM_DISABLE === "1") return;
    try {
      await write([{ type, actorId: agent, threadId: `${agent}-${session}`, payload: {
        session_id: session, correlation_id: correlation, cwd, source: "process",
        occurred_at: new Date().toISOString(), ...extra,
      } }]);
    } catch { recordError("run", "could not record agent process metadata"); }
  };
  await emit("agent.process.started");
  let child;
  try {
    child = spawn(command, args, { cwd, stdio: "inherit", env: {
      ...env, EVENTLOOM_CORRELATION_ID: correlation,
      EVENTLOOM_ACTOR: agent, EVENTLOOM_SESSION_ID: session,
    } });
  } catch {
    await emit("agent.process.failed", { outcome: "failure", exit_code: 127, reason: "launch_failed" });
    return 127;
  }
  const signals = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      // With inherited interactive stdio, the terminal sends Ctrl+C to both
      // processes in the foreground group. Relaying it again can make an
      // agent treat one cancel as a double interrupt and exit.
      if (signal === "SIGINT" && process.stdin.isTTY) return;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    signals.set(signal, handler);
    process.on(signal, handler);
  }
  let launchFailed = false;
  const result = await new Promise((resolve) => {
    child.once("error", () => { launchFailed = true; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  for (const [signal, handler] of signals) process.off(signal, handler);
  const code = launchFailed ? 127 : result.code ?? 128 + (constants.signals[result.signal] ?? 1);
  const success = code === 0 && !result.signal;
  await emit(success ? "agent.process.completed" : "agent.process.failed", {
    duration_ms: Math.round(performance.now() - started), outcome: success ? "success" : "failure", exit_code: code,
    ...(launchFailed ? { reason: "launch_failed" } : result.signal ? { reason: result.signal } : {}),
  });
  return code;
}
