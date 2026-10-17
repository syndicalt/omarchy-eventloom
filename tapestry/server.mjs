// tapestry server — reads eventloom shards, serves the weave-spec + three.js app.
// Read-only projection: the sealed log is never touched.
//   eventloom tapestry [--port N] [--days N|all] [--correlation <goal-id>]
// The port is --port, else EVENTLOOM_TAPESTRY_PORT, else the tapestry_port
// setting, else 4747.
// How much of the log is woven is the page's to say: /?days=N weaves the last
// N daily shards, and without a days parameter the whole log. --days only
// sets the number in the address this prints.
//
// The log is private to its owner, and a loopback port is not: any user of
// the machine can connect to it. So the log's projection, /weave.json, is
// answered only for a random key made at start-up, and that key reaches the
// owner's browser through a page only the owner can read. See writeLaunchPage.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RECALL_TYPE } from "../lib/memory.mjs";
import { tapestryPort } from "../lib/config.mjs";
import { launchPagePath, listShardPaths } from "../lib/paths.mjs";
import { SHARD_ANCHOR_TYPE, familyOf } from "../lib/vocabulary.mjs";

// Shard bookkeeping, not agent work: never woven.
const UNWOVEN = new Set([SHARD_ANCHOR_TYPE]);

// A deliberately representative, in-memory weave. It is only used with
// --demo, never merged with or written to a user's sealed shard.
export function demoEvents() {
  const base = Date.UTC(2026, 9, 10, 8, 0);
  const out = [];
  const add = (minutes, type, actor, session, payload = {}, causedBy = []) => {
    const id = "demo-" + String(out.length + 1).padStart(3, "0");
    out.push({
      id, day: "2026-10-10", line: out.length, ts: new Date(base + Math.round(minutes * 60_000)).toISOString(), type,
      family: familyOf(type), actor, thread: actor + "-main",
      session, correlation: payload.correlation_id ?? null, tool: payload.tool ?? null,
      duration: payload.duration_ms ?? 0, exit: payload.exit_code ?? null,
      ok: (payload.exit_code ?? 0) === 0 && !type.endsWith(".failed"),
      parent: causedBy[0] ?? null, causedBy,
      payload, hash: null, prevHash: null,
    });
    return id;
  };
  const tool = (minutes, actor, session, name, ms, failed = false) => {
    add(minutes, "agent.tool.started", actor, session, { tool: name });
    return add(minutes + ms / 60_000, failed ? "agent.tool.failed" : "agent.tool.completed", actor, session,
      { tool: name, duration_ms: ms, ...(failed ? { exit_code: 1 } : {}) });
  };
  const burst = (from, actor, session, names, gap = 0.22) => {
    let last = null;
    names.forEach((name, i) => { last = tool(from + i * gap, actor, session, name, 300 + ((i * 7919) % 9) * 900); });
    return last;
  };

  add(0, "agent.session.started", "omp", "research");
  add(0.4, "agent.model.started", "omp", "research", { model: "opus" });
  burst(1, "omp", "research", ["rg", "read", "read", "rg", "read", "bash"]);
  burst(4, "omp", "research", ["read", "web", "read", "rg"]);
  add(7.5, "agent.note.added", "omp", "research", { note: "plan" });
  const planned = add(10.5, "agent.reply.summarized", "omp", "research", {
    summary: "Compared the two release paths. Chose the staged rollout; the migration script still needs a dry run.", tags: ["release"],
  });
  burst(8, "omp", "research", ["bash", "read", "bash"]);
  const asked = add(12, "agent.approval.requested", "omp", "research");
  add(13.2, "agent.approval.resolved", "omp", "research", {}, [asked]);
  burst(14, "omp", "research", ["bash", "read"]);
  const handoff = add(18, "agent.handoff", "omp", "research", { to_session_id: "build", correlation_id: "release" });
  add(22, "agent.session.completed", "omp", "research");

  add(14, "agent.session.started", "claude", "review");
  burst(15, "claude", "review", ["read", "read", "grep", "read"]);
  add(18, "agent.note.added", "claude", "review", { note: "findings" });
  const reviewed = add(19.5, "agent.reply.summarized", "claude", "review", {
    summary: "Reviewed the rollout plan: the rollback step is missing a health check. Left it for the build session.",
  });
  add(31, "agent.session.resumed", "claude", "review");
  burst(32, "claude", "review", ["read", "edit", "edit", "bash", "edit"]);
  add(36, "agent.file.mutated", "claude", "review");
  add(42, "agent.session.completed", "claude", "review");

  add(20, "agent.session.started", "codex", "build", { correlation_id: "release" }, [handoff]);
  add(20.2, "agent.memory.recalled", "codex", "build", { recalled: [planned, reviewed], count: 2 });
  add(20.5, "agent.model.started", "codex", "build", { model: "gpt" });
  burst(21, "codex", "build", ["read", "apply_patch", "apply_patch", "test", "apply_patch", "test", "read", "apply_patch"]);
  const tested = burst(26, "codex", "build", ["test", "apply_patch", "test"]);
  burst(30, "codex", "build", ["apply_patch", "test", "bash", "test", "apply_patch", "test"]);
  add(35, "agent.file.mutated", "codex", "build");
  add(38, "agent.git.mutated", "codex", "build");
  add(41, "agent.reply.summarized", "codex", "build", {
    summary: "Ran the migration dry run and added the health check to rollback. Tests pass; released.", tags: ["release"],
  });
  add(43, "agent.session.completed", "codex", "build", { goal_completed: true });

  add(29, "agent.session.started", "omp", "experiment", {}, [tested]);
  add(29.3, "agent.memory.recalled", "omp", "experiment", { recalled: [planned], count: 1 });
  burst(30, "omp", "experiment", ["bash", "read", "bash"]);
  tool(36, "omp", "experiment", "bash", 5200, true);
  add(40, "agent.session.failed", "omp", "experiment");
  return out;
}

// Parsed shards, keyed by path and reused until the file changes on disk.
const shardCache = new Map();

function readShard(file, day) {
  const stat = statSync(file);
  const cached = shardCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.events;
  const events = [];
  for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a corrupt line is `eventloom verify`'s to report
    }
    if (!e || typeof e !== "object" || typeof e.type !== "string" || UNWOVEN.has(e.type)) continue;
    const payload = e.payload && typeof e.payload === "object" ? e.payload : {};
    // Adapters stamp when the thing happened; the envelope only knows when it
    // was sealed, which can be later and out of order.
    const ts = eventTime(payload.occurred_at) !== null ? payload.occurred_at : e.timestamp ?? e.ts ?? null;
    events.push({
      id: e.id,
      day,
      line: i,
      ts,
      type: e.type,
      family: familyOf(e.type),
      actor: String(e.actorId ?? e.actor ?? "unknown"),
      thread: e.threadId ?? e.thread ?? null,
      correlation: payload.correlation_id ?? null,
      session: payload.session_id ?? null,
      tool: payload.tool ?? null,
      duration: payload.duration_ms ?? null,
      exit: payload.exit_code ?? null,
      ok: (payload.exit_code ?? 0) === 0 && !/failed/.test(e.type),
      parent: e.parentEventId ?? null,
      causedBy: Array.isArray(e.causedBy) ? e.causedBy : [],
      payload,
      hash: e.integrity?.hash ?? null,
      prevHash: e.integrity?.previousHash ?? null,
    });
  }
  shardCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events });
  return events;
}

// The last `days` daily shards, or every shard when `days` is null.
function loadShards(days) {
  const events = [];
  const shards = listShardPaths();
  for (const file of days === null ? shards : shards.slice(-days)) {
    try {
      for (const event of readShard(file, path.basename(file, ".jsonl"))) events.push(event);
    } catch { /* a shard that vanished or cannot be read is skipped */ }
  }
  return events;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MULTI_DAY_MS = 36 * 60 * 60 * 1000;

export function eventTime(ts) {
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : null;
  if (typeof ts !== "string") return null;
  const time = Date.parse(ts);
  return Number.isFinite(time) ? time : null;
}

// Short wall-clock buckets inside a day; one bucket per day once a segment
// spans more than a day and a half.
export function activityBinCount(start, end) {
  const span = Math.max(0, end - start);
  if (span >= MULTI_DAY_MS) return Math.max(1, Math.ceil(span / DAY_MS));
  return Math.max(3, Math.min(12, Math.ceil(span / (20 * 60 * 1000)) || 1));
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

// Greedy interval packing. Overlapping segments do not share a column.
export function placeColumns(sessions) {
  const columns = [];
  const ordered = [...sessions].sort((a, b) => a.start - b.start || a.end - b.end || String(a.id).localeCompare(String(b.id)));
  for (const session of ordered) {
    let placed = false;
    for (let index = 0; index < columns.length; index++) {
      if (columns[index] <= session.start) {
        session.column = index;
        columns[index] = session.end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      session.column = columns.length;
      columns.push(session.end);
    }
  }
  return Math.max(1, columns.length);
}

// Derived, disposable session geometry. The raw stitches remain available for
// close inspection; this only gives the renderer a stable overview shape.
export function deriveSessions(stitches) {
  const timed = stitches.filter((stitch) => eventTime(stitch.ts) !== null);
  const grouped = new Map();
  for (const stitch of timed) {
    const key = stitch.session ?? (stitch.actor + ":" + (stitch.thread ?? "unthreaded"));
    (grouped.get(key) ?? grouped.set(key, []).get(key)).push(stitch);
  }
  const sessions = [];
  for (const [sessionId, events] of grouped) {
    const ordered = [...events].sort((a, b) => eventTime(a.ts) - eventTime(b.ts));
    let segment = null;
    let previous = null;
    let ordinal = 0;
    for (const event of ordered) {
      const boundary = event.type === "agent.session.started" || event.type === "agent.session.resumed";
      if (!segment || boundary) {
        if (segment) sessions.push(segment);
        const resumed = event.type === "agent.session.resumed";
        segment = {
          id: sessionId + ":" + ordinal++,
          sessionId,
          actor: event.actor,
          thread: event.thread,
          stitches: [],
          resumed,
          resumeOf: resumed ? previous?.id ?? null : null,
        };
        previous = segment;
      }
      segment.stitches.push(event);
    }
    if (segment) sessions.push(segment);
  }
  return sessions.map((session) => {
    const entries = session.stitches;
    const start = eventTime(entries[0].ts);
    const end = Math.max(start + 60_000, eventTime(entries.at(-1).ts));
    const bins = activityBinCount(start, end);
    const counts = Array.from({ length: bins }, () => 0);
    for (const entry of entries) {
      const i = Math.max(0, Math.min(bins - 1, Math.floor(((eventTime(entry.ts) - start) / (end - start)) * bins)));
      counts[i] += 1 + Math.min(2, Math.log2(1 + (entry.duration ?? 0) / 1000));
    }
    const peak = Math.max(...counts, 1);
    const final = entries.at(-1);
    const status = final.type === "agent.session.completed" ? "completed"
      : final.type === "agent.session.failed" ? "failed" : "open";
    const activity = counts.map((count, i) => ({ t: (i + .5) / bins, count, value: count / peak }));
    return {
      id: session.id,
      sessionId: session.sessionId,
      actor: session.actor,
      thread: session.thread,
      start,
      end,
      events: entries.map((entry) => entry.id),
      eventCount: entries.length,
      toolCount: entries.filter((entry) => entry.family === "tool").length,
      approvalCount: entries.filter((entry) => entry.family === "approval").length,
      status,
      completion: status === "completed" || entries.some((entry) => entry.payload?.goal_completed === true),
      failure: status === "failed" || entries.some((entry) => !entry.ok),
      resumed: session.resumed,
      resumeOf: session.resumeOf,
      seed: hashSeed(session.id),
      activity,
      samples: activity.map((bin) => bin.value),
    };
  });
}

export function sessionKey(stitch) {
  return stitch.session ?? (stitch.actor + ":" + (stitch.thread ?? "unthreaded"));
}

// Yarn between log lines: every way one sealed event points at another.
//   cause       parentEventId / causedBy
//   handoff     agent.handoff -> the first event of the receiving session
//   resume      the last event before a resume -> the resume
//   correlation consecutive events that share a correlation across sessions
export function deriveLinks(stitches) {
  const byId = new Map(stitches.map((stitch) => [stitch.id, stitch]));
  const links = [];
  const seen = new Set();
  const push = (from, to, kind) => {
    if (!from || !to || from === to || !byId.has(from) || !byId.has(to)) return;
    const pair = from + ">" + to;
    if (seen.has(pair)) return;
    seen.add(pair);
    links.push({ from, to, kind });
  };
  const lastInSession = new Map();
  const lastInCorrelation = new Map();
  for (const stitch of stitches) {
    for (const cause of new Set([stitch.parent, ...(stitch.causedBy ?? [])])) {
      if (cause) push(cause, stitch.id, "cause");
    }
    const key = sessionKey(stitch);
    if (stitch.type === "agent.session.resumed") push(lastInSession.get(key), stitch.id, "resume");
    lastInSession.set(key, stitch.id);
    if (stitch.family === "handoff") {
      const target = stitch.payload?.to_session_id ?? stitch.payload?.to ?? null;
      const at = eventTime(stitch.ts);
      const receiver = target && (
        stitches.find((other) => other.session === target && eventTime(other.ts) >= at)
        ?? stitches.find((other) => other.session === target)
        ?? stitches.find((other) => other.actor === target && sessionKey(other) !== key && eventTime(other.ts) >= at)
      );
      if (receiver) push(stitch.id, receiver.id, "handoff");
    }
    // A recall names the summaries it handed over: each is a memory thread
    // from the session that wrote it to the one that read it.
    if (stitch.type === RECALL_TYPE && Array.isArray(stitch.payload?.recalled)) {
      for (const remembered of stitch.payload.recalled) push(remembered, stitch.id, "memory");
    }
    if (stitch.correlation) {
      const previous = byId.get(lastInCorrelation.get(stitch.correlation));
      if (previous && sessionKey(previous) !== key) push(previous.id, stitch.id, "correlation");
      lastInCorrelation.set(stitch.correlation, stitch.id);
    }
  }
  return links;
}

// The payload fields the inspector may show. Everything else in a payload
// stays in the shard.
const DETAIL = ["summary", "tags", "project", "count", "model", "status", "reason", "title", "name", "kind", "fleet_event_type", "to", "from", "exit_code"];
// A summary is the one field shown whole: it is short by construction, and
// reading it is the point.
const WHOLE = new Set(["summary"]);

function detailOf(payload) {
  const detail = {};
  for (const key of DETAIL) {
    const listed = payload?.[key];
    const value = Array.isArray(listed) && listed.every((item) => typeof item === "string") ? listed.join(", ") : listed;
    if (typeof value === "string" && value) detail[key] = value.length > 140 && !WHOLE.has(key) ? value.slice(0, 139) + "…" : value;
    else if (typeof value === "number" && Number.isFinite(value)) detail[key] = value;
  }
  return detail;
}

// What the page receives for one log line: enough to place, stitch and name
// it, and no more.
function slim(stitch) {
  return {
    id: stitch.id,
    ts: stitch.ts,
    at: eventTime(stitch.ts),
    type: stitch.type,
    family: stitch.family,
    actor: stitch.actor,
    thread: stitch.thread ?? null,
    session: stitch.session ?? null,
    correlation: stitch.correlation ?? null,
    tool: stitch.tool ?? null,
    duration: stitch.duration ?? 0,
    ok: stitch.ok !== false,
    goal_completed: stitch.payload?.goal_completed === true,
    hash: typeof stitch.hash === "string" ? stitch.hash.replace(/^sha256:/, "").slice(0, 16) : null,
    detail: detailOf(stitch.payload),
  };
}

// Weave-spec: the full weaving instruction for the canvas.
export function weaveSpec(events) {
  const skipped = events.filter((event) => eventTime(event.ts) === null).map((event) => event.id ?? null);
  const timed = events.filter((event) => eventTime(event.ts) !== null);
  const stitches = timed
    .map((event, index) => ({ event, index }))
    .sort((a, b) => eventTime(a.event.ts) - eventTime(b.event.ts) || a.index - b.index)
    .map(({ event }) => event);
  const t0 = stitches[0]?.ts ?? null;
  const t1 = stitches.at(-1)?.ts ?? null;

  const handoffs = stitches
    .filter((s) => s.family === "handoff")
    .map((s) => ({
      id: s.id,
      at: eventTime(s.ts),
      fromSession: s.session ?? null,
      toSession: s.payload?.to_session_id ?? s.payload?.to ?? null,
    }))
    .filter((s) => s.toSession);

  const sessions = deriveSessions(stitches);
  const columnCount = placeColumns(sessions);

  return { stitches: stitches.map(slim), sessions, columnCount, handoffs, links: deriveLinks(stitches), skipped, span: { t0, t1 } };
}

export function filterCorrelation(events, correlation) {
  if (!correlation) return events;
  return events.filter((event) => event.correlation === correlation || event.payload?.goal_id === correlation);
}

// Everything the page may load. Read once at start; nothing else on disk is
// reachable.
const ASSET_FILES = {
  "/": "index.html",
  "/weave.js": "weave.js",
  "/fabric.js": "fabric.js",
  "/yarn.js": "yarn.js",
  "/layout.mjs": "layout.mjs",
  "/motif.mjs": "motif.mjs",
  "/playback.mjs": "playback.mjs",
};
// three.js is a pinned dependency, installed beside the runtime, and served
// from there under the address the page imports. Its package exports the
// build directory only through its main entry, so that is what is resolved.
const THREE_MODULE = path.join(path.dirname(createRequire(import.meta.url).resolve("three")), "three.module.min.js");

function loadAssets() {
  const assets = {
    "/vendor/three.module.min.js": { type: "text/javascript; charset=utf-8", body: readFileSync(THREE_MODULE) },
  };
  for (const [route, file] of Object.entries(ASSET_FILES)) {
    assets[route] = {
      type: file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      body: readFileSync(new URL("./" + file, import.meta.url)),
    };
  }
  return assets;
}

function usage(message) {
  console.error(`eventloom tapestry: ${message}\nusage: eventloom tapestry [--port 4747] [--days 7|all] [--correlation <goal-id>] [--demo]`);
  process.exitCode = 1;
  return null;
}

// The days parameter of a request: a positive whole number, or null (the
// whole log) when it is absent or left empty.
export function requestedDays(searchParams) {
  const raw = searchParams.get("days")?.trim() ?? "";
  if (raw === "") return null;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new RangeError("days must be a positive whole number; leave it out to weave the whole log");
  }
  return Number(raw);
}

// The address to open: the default number of days is part of it, where it
// can be seen, changed, or removed.
export function launchUrl({ port, days, correlation }) {
  const query = new URLSearchParams();
  if (days !== null) query.set("days", String(days));
  if (correlation) query.set("correlation", correlation);
  const text = query.toString();
  return `http://127.0.0.1:${port}/${text ? `?${text}` : ""}`;
}

// The key must not appear anywhere another user can look. An address given to
// `xdg-open` or a browser shows in the process list, so the address is never
// handed over directly: this page, mode 0600, carries it and sends the
// browser on. The key rides in the fragment, which browsers do not send to
// servers or put in a Referer; the Tapestry page reads it from there.
function writeLaunchPage(file, address, key) {
  const target = JSON.stringify(`${address}#key=${key}`).replaceAll("<", "\\u003c");
  const page = `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Opening the Tapestry</title>
<script>location.replace(${target})</script>
<p>Opening the Tapestry…</p>
`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  writeFileSync(file, page, { mode: 0o600 });
  chmodSync(file, 0o600); // the mode given to writeFileSync is cut down by the umask, and kept for an existing file
}

// Does the request carry this run's key? Compared in constant time.
function carriesKey(req, key) {
  const offered = Buffer.from(String(req.headers.authorization ?? ""));
  const expected = Buffer.from(`Bearer ${key}`);
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

export function main(argv) {
  let port, days = 7, demo = false, correlation = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--demo") demo = true;
    else if (arg === "--days" && argv[i + 1] === "all") {
      days = null;
      i += 1;
    } else if (arg === "--port" || arg === "--days") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || (arg === "--port" && value > 65535)) return usage(`${arg} needs a positive whole number`);
      if (arg === "--port") port = value;
      else days = value;
    } else if (arg === "--correlation") {
      correlation = argv[++i] || null;
      if (!correlation) return usage("--correlation needs a goal id");
    } else return usage(`unknown option ${arg}`);
  }
  try {
    port = tapestryPort({ flag: port });
  } catch (err) {
    return usage(err.message);
  }
  const ASSETS = loadAssets();
  const accessKey = randomBytes(32).toString("base64url");
  const launchPage = launchPagePath(port);
  // The log is private. Answer only requests addressed to this machine, so a
  // page on another origin cannot reach it by rebinding a hostname.
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const reply = (res, status, type, body, head) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(head ? undefined : body);
  };
  const server = createServer((req, res) => {
    const head = req.method === "HEAD";
    try {
      if (!hosts.has(req.headers.host ?? "")) return reply(res, 403, "text/plain; charset=utf-8", "forbidden", head);
      if (req.method !== "GET" && !head) return reply(res, 405, "text/plain; charset=utf-8", "method not allowed", head);
      const request = new URL(req.url, "http://eventloom.local");
      if (request.pathname === "/weave.json") {
        if (!carriesKey(req, accessKey)) {
          res.setHeader("www-authenticate", "Bearer");
          return reply(res, 401, "text/plain; charset=utf-8", "This Tapestry is private to the user who started it. Open it with: eventloom tapestry", head);
        }
        const requestedCorrelation = request.searchParams.get("correlation") || correlation;
        let shown;
        try {
          shown = requestedDays(request.searchParams);
        } catch (error) {
          return reply(res, 400, "text/plain; charset=utf-8", error.message, head);
        }
        const spec = weaveSpec(filterCorrelation(demo ? demoEvents() : loadShards(shown), requestedCorrelation));
        spec.filter = { correlation: requestedCorrelation, days: shown };
        return reply(res, 200, "application/json", JSON.stringify(spec), head);
      }
      const file = ASSETS[request.pathname === "/index.html" ? "/" : request.pathname];
      if (!file) return reply(res, 404, "text/plain; charset=utf-8", "not found", head);
      return reply(res, 200, file.type, file.body, head);
    } catch (error) {
      console.error("tapestry:", error?.message ?? error);
      if (!res.headersSent) reply(res, 500, "text/plain; charset=utf-8", "the loom jammed; see the terminal", head);
      else res.end();
    }
  });
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE"
      ? `eventloom tapestry: port ${port} is already in use; pass --port <n>`
      : `eventloom tapestry: ${error.message}`);
    process.exitCode = 1;
  });
  const forgetLaunchPage = () => rmSync(launchPage, { force: true });
  server.on("close", forgetLaunchPage);
  process.once("exit", forgetLaunchPage);
  server.listen(port, "127.0.0.1", () => {
    writeLaunchPage(launchPage, launchUrl({ port, days: demo ? null : days, correlation }), accessKey);
    const shown = demo ? "demo weave" : days === null ? "whole log" : `last ${days} day(s)`;
    console.log(`tapestry: open file://${launchPage} (${shown})`);
    console.log(`          it leads to http://127.0.0.1:${port}/ with a key that only you can read; the bare address shows nothing`);
    if (!demo) console.log("          change ?days=N in the address for more or fewer days; remove it for the whole log");
  });
  server.launchPage = launchPage;
  return server;
}
