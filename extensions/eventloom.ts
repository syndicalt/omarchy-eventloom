// eventloom adapter for omp. Records session lifecycle, model turns, tool
// calls and approvals in the Omarchy agent event log, and before a session's
// first turn hands the agent the project's memory, if the owner turned it on:
// the summaries agents have recorded there, and how to add one
// (`eventloom brief`, which says nothing when memory is off).
//
// The event and context shapes below are the subset of omp's extension API
// this file reads. Nothing here may slow or break the agent: events are
// queued in memory and written by one `eventloom ingest` process at a time,
// which also keeps them in order. The one exception is shutdown, where
// whatever is still queued goes to a second process at once.

import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs";
import path from "node:path";

interface ExtensionContext {
  cwd?: string;
  model?: { id?: string };
  sessionManager?: { getSessionId?(): string | undefined };
}

interface OmpEvents {
  session_start: object;
  session_switch: { reason?: string };
  session_shutdown: object;
  before_agent_start: object;
  agent_start: object;
  agent_end: object;
  tool_execution_start: { toolCallId: string; toolName: string; args?: unknown };
  tool_execution_end: { toolCallId: string; toolName: string; isError?: boolean };
  tool_approval_requested: { toolCallId: string; toolName: string; reason?: string; approvalMode?: string };
  tool_approval_resolved: { toolCallId: string; toolName: string; approved?: boolean; reason?: string };
}

// What a before_agent_start handler may return: a message put in front of
// the agent ahead of the turn, not shown to the user.
interface InjectedMessage {
  message: { customType: string; content: string; display: boolean; attribution: "agent" };
}

interface ExtensionApi {
  on<Name extends keyof OmpEvents>(
    name: Name,
    handler: (event: OmpEvents[Name], ctx: ExtensionContext) => void | Promise<InjectedMessage | undefined>,
  ): void;
}

type Payload = Record<string, unknown>;

const HOME = process.env.HOME ?? "";
const EVENTLOOM = `${HOME}/.local/bin/eventloom`;
// Beside the log directory, as lib/paths.mjs places it.
const LOG_DIR = process.env.EVENTLOOM_LOG_DIR || `${HOME}/.local/state/omarchy/agents/logs`;
const ERROR_LOG = path.join(path.dirname(LOG_DIR), "eventloom-errors.log");
function reportError(message: string): void {
  // Same file and line format as lib/error-log.mjs; `eventloom doctor` reads it.
  // Nothing can be done if this write fails too, so its result is not checked.
  mkdir(path.dirname(ERROR_LOG), { recursive: true, mode: 0o700 }, () => {
    appendFile(ERROR_LOG, `${new Date().toISOString()}\tomp-adapter\t${message}\n`, { mode: 0o600 }, () => {});
  });
}

// A child's stdio pipes are sockets at run time, though typed as plain streams.
function unrefPipe(pipe: unknown): void {
  const socket = pipe as { unref?: () => void };
  if (typeof socket.unref === "function") socket.unref();
}

// Runs `eventloom ingest` on one batch. The process is detached so that it
// finishes the write even if omp exits first. `done` is called exactly once.
function ingest(batch: string[], done: () => void): void {
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    done();
  };
  let child;
  try {
    child = spawn(EVENTLOOM, ["ingest"], { detached: true, stdio: ["pipe", "ignore", "pipe"] });
  } catch (err) {
    // spawn itself can throw (out of memory, descriptor limits); the batch is lost
    reportError(`could not run ${EVENTLOOM}: ${err instanceof Error ? err.message : String(err)}`);
    finish();
    return;
  }
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 2000) stderr += String(chunk);
  });
  // A failed spawn reports "error" and, depending on the runtime, may or may
  // not follow it with "close"; move on at whichever comes first.
  child.on("error", (err) => {
    reportError(`could not run ${EVENTLOOM}: ${err.message}`);
    finish();
  });
  child.on("close", (code) => {
    // eventloom prints "eventloom: …" for failures it has already recorded.
    // Anything else on a failed exit is a crash nobody else will report.
    if (code !== 0 && !stderr.startsWith("eventloom:")) {
      // a stack trace opens with a source location and the offending line;
      // the line that starts with the error's name is the useful one
      const lines = stderr.trim().split("\n");
      reportError(`eventloom ingest exited ${code}: ${lines.find((line) => /^\w*Error\b/.test(line)) ?? lines.at(-1)}`);
    }
    finish();
  });
  // A closed pipe means ingest died early, which the close handler reports.
  child.stdin.on("error", () => {});
  child.stdin.end(`${batch.join("\n")}\n`);
  // Neither the process nor its pipes may keep omp alive once omp is done.
  child.unref();
  unrefPipe(child.stdin);
  unrefPipe(child.stderr);
}

// The briefing for a session that is about to take its first turn. The turn
// waits for it, so it is given two seconds and no more; on any failure the
// agent simply starts without one.
const BRIEF_TIMEOUT_MS = 2000;

function brief(session: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(EVENTLOOM, ["brief", "--actor", "omp", "--session", session, "--cwd", cwd], {
        timeout: BRIEF_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: "utf8",
      }, (err, stdout) => resolve(err ? "" : stdout.trim()));
    } catch {
      resolve("");
    }
  });
}

// One writer at a time. Events that arrive while it runs go out together in
// the next batch, so a burst costs one process and one lock, not one each,
// and batches are sealed in the order they were queued.
function createWriter() {
  let queued: string[] = [];
  let writing = false;

  function flush(): void {
    if (writing || queued.length === 0) return;
    writing = true;
    const batch = queued;
    queued = [];
    ingest(batch, () => {
      writing = false;
      flush();
    });
  }

  return {
    write(line: string): void {
      queued.push(line);
      flush();
    },
    // At shutdown there is no later turn in which to flush: whatever is still
    // queued behind a running batch goes to a second process straight away.
    // The two then race for the shard lock, so across that boundary the log's
    // order can differ from the order of events; `occurred_at` still holds.
    handOff(): void {
      if (queued.length === 0) return;
      const batch = queued;
      queued = [];
      ingest(batch, () => {});
    },
  };
}

export default function eventloomAdapter(omp: ExtensionApi): void {
  if (HOME === "" || process.env.EVENTLOOM_DISABLE === "1") return;

  const writer = createWriter();
  const toolStartedAt = new Map<string, number>();
  let sessionId: string | undefined;
  let turnStartedAt: number | undefined;

  function emit(type: string, ctx: ExtensionContext, payload: Payload = {}): void {
    writer.write(JSON.stringify({
      type,
      actor: "omp",
      thread: `omp-${sessionId}`,
      payload: {
        session_id: sessionId,
        correlation_id: process.env.EVENTLOOM_CORRELATION_ID || `omp-${sessionId}`,
        occurred_at: new Date().toISOString(),
        cwd: ctx.cwd ?? process.cwd(),
        ...payload,
      },
    }));
  }

  // The session is read from the context on every event, since most of omp's
  // events do not name it. A changed id means omp moved to another session:
  // close the old one, open the new one.
  function enterSession(ctx: ExtensionContext, opening: "started" | "resumed", reason: string): void {
    const current = ctx.sessionManager?.getSessionId?.() || `pid-${process.pid}`;
    if (current === sessionId) return;
    if (sessionId !== undefined) emit("agent.session.completed", ctx, { reason: "switch" });
    sessionId = current;
    // `eventloom note`, typed by the agent in a shell omp starts, finds its
    // session here.
    process.env.EVENTLOOM_ACTOR = "omp";
    process.env.EVENTLOOM_SESSION_ID = current;
    emit(`agent.session.${opening}`, ctx, { reason });
  }

  const briefed = new Set<string>();
  omp.on("before_agent_start", async (_event, ctx) => {
    enterSession(ctx, "started", "turn");
    if (sessionId === undefined || briefed.has(sessionId) || process.env.EVENTLOOM_MEMORY === "0") return undefined;
    briefed.add(sessionId);
    const content = await brief(sessionId, ctx.cwd ?? process.cwd());
    return content ? { message: { customType: "eventloom-memory", content, display: false, attribution: "agent" } } : undefined;
  });

  omp.on("session_start", (_event, ctx) => enterSession(ctx, "started", "start"));

  omp.on("session_switch", (event, ctx) => {
    const reason = event.reason ?? "switch";
    // "new" and "fork" create a session; anything else returns to an existing one
    enterSession(ctx, reason === "new" || reason === "fork" ? "started" : "resumed", reason);
  });

  omp.on("agent_start", (_event, ctx) => {
    enterSession(ctx, "started", "turn");
    turnStartedAt = Date.now();
    emit("agent.model.started", ctx, { model: ctx.model?.id });
  });

  omp.on("agent_end", (_event, ctx) => {
    if (sessionId === undefined || turnStartedAt === undefined) return;
    emit("agent.model.completed", ctx, { model: ctx.model?.id, duration_ms: Date.now() - turnStartedAt });
    turnStartedAt = undefined;
  });

  omp.on("tool_execution_start", (event, ctx) => {
    enterSession(ctx, "started", "tool");
    toolStartedAt.set(event.toolCallId, Date.now());
    const args = event.args;
    emit("agent.tool.started", ctx, {
      tool: event.toolName,
      tool_use_id: event.toolCallId,
      // argument names only: they say what kind of call it was without quoting it
      tool_input_keys: args !== null && typeof args === "object" ? Object.keys(args).sort() : undefined,
    });
  });

  omp.on("tool_execution_end", (event, ctx) => {
    enterSession(ctx, "started", "tool");
    const startedAt = toolStartedAt.get(event.toolCallId);
    toolStartedAt.delete(event.toolCallId);
    emit(event.isError ? "agent.tool.failed" : "agent.tool.completed", ctx, {
      tool: event.toolName,
      tool_use_id: event.toolCallId,
      duration_ms: startedAt === undefined ? undefined : Date.now() - startedAt,
    });
  });

  omp.on("tool_approval_requested", (event, ctx) => {
    enterSession(ctx, "started", "approval");
    emit("agent.approval.requested", ctx, { tool: event.toolName, approval_mode: event.approvalMode });
  });

  omp.on("tool_approval_resolved", (event, ctx) => {
    enterSession(ctx, "started", "approval");
    emit("agent.approval.resolved", ctx, { tool: event.toolName, approved: event.approved });
  });

  omp.on("session_shutdown", (_event, ctx) => {
    if (sessionId === undefined) return;
    emit("agent.session.completed", ctx, { reason: "shutdown" });
    sessionId = undefined;
    writer.handOff();
  });
}
