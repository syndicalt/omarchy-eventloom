#!/usr/bin/env node
// eventloom — universal append-only agent event log for Omarchy, powered by @eventloom/runtime.
// Log path: ~/.local/state/omarchy/agents/logs/YYYY-MM-DD.jsonl (daily shard, hash-chained, tamper-evident).
import { appendExternalEvent, createRuntime } from "@eventloom/runtime";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseSettingsText, mergeClaudeHooks, stripClaudeHooks, claudeHooksWired } from "./claude-settings.mjs";
import { LOG_DIR, applyCaptureMode, sessionProvenance, EventTypes, loadAdapters, adaptersManifestPath, todayPath, ensureLogDir, secureLogFile, listShardPaths } from "./engine.mjs";

const SESSION_OPEN = new Set([EventTypes.sessionStarted, EventTypes.sessionResumed]);

function fail(msg) {
  console.error(`eventloom: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  let [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h") return { cmd: null, opts: { help: true } };
  if (cmd === "tapestry") return { cmd, opts: { tapestryArgs: rest } };
  const opts = { type: null, actor: "unknown", payload: "{}", thread: "thread_main", limit: 20, log: null, actorGiven: false };
  // omarchy-agent-* wrappers pass the subcommand as a positional alias.
  if (rest.length && !rest[0].startsWith("--") && ["tail", "verify", "doctor", "path", "inspect"].includes(rest[0]) && cmd !== rest[0]) {
    cmd = rest.shift();
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const take = (flag) => {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) fail(`${flag} requires a value`);
      return value;
    };
    if (a === "--actor") { opts.actor = take(a); opts.actorGiven = true; }
    else if (a === "--payload") opts.payload = take(a);
    else if (a === "--thread") opts.thread = take(a);
    else if (a === "--limit") opts.limit = parseInt(take(a), 10);
    else if (a === "--log") opts.log = take(a);
    else if (a === "--correlation") opts.correlation = take(a);
    else if (a === "--cwd") opts.cwd = take(a);
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("--") && cmd === "append") {
      if (opts.type === null) opts.type = a;
      else fail(`unexpected argument: ${a}`);
    } else if (!a.startsWith("--")) {
      if (cmd === "wire-claude-hooks" || cmd === "unwire-claude-hooks") opts.hookPath = a;
      else fail(`unexpected argument: ${a}`);
    }
  }
  return { cmd, opts };
}

const HELP = `eventloom — universal append-only agent event log for Omarchy

Usage:
  eventloom append <event.type> [--actor <id>] [--thread <id>] [--payload '<json>']
                  [--correlation <id>] [--cwd <path>]
  eventloom tail [--limit N] [--actor <id>] [--log <path>]
  eventloom verify [--log <path>]   # every daily shard unless --log is set
  eventloom doctor          # adapter install and wiring status
  eventloom path
  eventloom tapestry [--port 4747] [--days 7] [--demo]
  eventloom wire-claude-hooks [hook-path]
  eventloom unwire-claude-hooks

Log: ~/.local/state/omarchy/agents/logs/YYYY-MM-DD.jsonl (local date, hash-chained)
Capture modes: EVENTLOOM_MODE=full (default) | summary | metadata
Exit codes: 0 ok, 1 usage error, 2 tampered/corrupt log.`;

function fillProvenance(type, actor, payload) {
  if (!SESSION_OPEN.has(type)) return payload;
  const prov = sessionProvenance(actor, payload.cwd);
  for (const [key, value] of Object.entries(prov)) {
    if (payload[key] === undefined && value !== undefined) payload[key] = value;
  }
  return payload;
}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  let text;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch (err) {
    fail(`refusing to rewrite ${settingsPath}: ${err.message}`);
  }
  try {
    return parseSettingsText(text, settingsPath);
  } catch (err) {
    fail(err.message);
  }
}

function writeSettings(settingsPath, settings) {
  mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(settingsPath, 0o600); } catch { /* best effort */ }
}

function tailEvents(text) {
  const shown = [];
  const bad = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      shown.push(JSON.parse(line));
    } catch {
      bad.push(index + 1);
    }
  }
  return { shown, bad };
}

async function verifyOne(logPath) {
  const runtime = createRuntime(logPath);
  const report = await runtime.verify();
  const ok = report?.ok === true;
  secureLogFile(logPath);
  return {
    path: logPath,
    ok,
    diagnostics: report?.diagnostics ?? [],
    errors: report?.errors ?? [],
  };
}

function inspectAdapter(adapter) {
  const hookPath = adapter.hook_path ? adapter.hook_path.replace(/^~/, homedir()) : null;
  const present = hookPath ? existsSync(hookPath) : false;
  if (adapter.agent === "claude") {
    const settingsPath = path.join(homedir(), ".claude", "settings.json");
    let wired = false;
    let detail = "settings unreadable";
    if (!existsSync(settingsPath)) detail = "settings missing";
    else {
      try {
        const settings = parseSettingsText(readFileSync(settingsPath, "utf8"), settingsPath);
        const status = claudeHooksWired(settings);
        wired = status.wired;
        detail = wired ? "settings wired" : `unwired: ${status.missing.join(", ")}`;
      } catch (err) {
        detail = err.message;
      }
    }
    const state = present && wired ? "wired    " : present ? "UNWIRED " : "MISSING ";
    return `  ${adapter.agent.padEnd(12)} ${state} ${present ? hookPath : adapter.hook_path} (${detail})`;
  }
  let recognized = false;
  if (present && hookPath) {
    try { recognized = readFileSync(hookPath, "utf8").includes("agent.session.started"); } catch { recognized = false; }
  }
  const state = present && recognized ? "wired    " : present ? "UNWIRED " : "MISSING ";
  const where = present ? hookPath : (adapter.hook_path ?? "");
  return `  ${adapter.agent.padEnd(12)} ${state} ${where} ${adapter.method ? `(${adapter.method})` : ""}`.trimEnd();
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (opts.help || !cmd) { console.log(HELP); return; }
  if (cmd === "tapestry") {
    const { main: tapestry } = await import(new URL("../tapestry/server.mjs", import.meta.url));
    tapestry(opts.tapestryArgs);
    return;
  }

  const logPath = opts.log ?? todayPath();
  if (cmd === "path") { console.log(logPath); return; }

  if (cmd === "append") {
    if (!opts.type) fail("append requires an event type, e.g. agent.session.started");
    if (!opts.actor) fail("--actor requires a value");
    if (!opts.thread) fail("--thread requires a value");
    let payload;
    try { payload = JSON.parse(opts.payload); } catch { fail("--payload must be valid JSON"); }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      fail("--payload must be a JSON object");
    }
    if (opts.correlation) payload.correlation_id = opts.correlation;
    if (opts.cwd) payload.cwd = opts.cwd;
    fillProvenance(opts.type, opts.actor, payload);
    // Redact secrets and apply capture mode before sealing (irreversible chain).
    const clean = applyCaptureMode(payload);
    ensureLogDir();
    const sealed = await appendExternalEvent({
      path: logPath,
      type: opts.type,
      actorId: opts.actor,
      threadId: opts.thread,
      payload: clean,
    });
    secureLogFile(logPath);
    console.log(JSON.stringify({ id: sealed.id, type: sealed.type, hash: sealed.integrity?.hash }));
    return;
  }

  if (cmd === "tail") {
    if (!Number.isInteger(opts.limit) || opts.limit < 0) fail("--limit must be a non-negative integer");
    if (!existsSync(logPath)) { console.log("(empty)"); return; }
    secureLogFile(logPath);
    const { shown, bad } = tailEvents(readFileSync(logPath, "utf8"));
    if (bad.length) console.error(`eventloom: skipped malformed line(s): ${bad.join(", ")}`);
    let events = shown;
    if (opts.actorGiven) events = events.filter((e) => e.actorId === opts.actor);
    const selected = opts.limit === 0 ? [] : events.slice(-opts.limit);
    for (const e of selected) {
      console.log(JSON.stringify({ ts: e.timestamp, type: e.type, actor: e.actorId, thread: e.threadId, payload: e.payload }));
    }
    return;
  }

  if (cmd === "verify") {
    const targets = opts.log ? [opts.log] : listShardPaths();
    if (opts.log && !existsSync(opts.log)) fail(`log not found: ${opts.log}`);
    if (!targets.length) {
      console.log(JSON.stringify({ ok: true, checked: 0, diagnostics: [], errors: [], reports: [] }));
      return;
    }
    const reports = [];
    for (const target of targets) reports.push(await verifyOne(target));
    const ok = reports.every((report) => report.ok);
    console.log(JSON.stringify({
      ok,
      checked: reports.length,
      diagnostics: reports.flatMap((report) => report.diagnostics),
      errors: reports.flatMap((report) => report.errors),
      reports,
    }));
    if (!ok) process.exit(2);
    return;
  }

  if (cmd === "wire-claude-hooks" || cmd === "unwire-claude-hooks") {
    const hookPath = opts.hookPath ?? `${homedir()}/.claude/hooks/eventloom-hook.sh`;
    const absHook = hookPath.replace(/^~/, homedir());
    const settingsPath = `${homedir()}/.claude/settings.json`;
    const settings = readSettings(settingsPath);
    if (cmd === "unwire-claude-hooks") {
      const stripped = stripClaudeHooks(settings);
      if (existsSync(settingsPath)) writeSettings(settingsPath, stripped.settings);
      console.log(JSON.stringify({ ok: true, removed: stripped.removed }));
      return;
    }
    const merged = mergeClaudeHooks(settings, absHook);
    writeSettings(settingsPath, merged.settings);
    console.log(JSON.stringify({ ok: true, added: merged.added, refreshed: merged.refreshed }));
    return;
  }

  if (cmd === "inspect" || cmd === "doctor") {
    ensureLogDir();
    const manifest = loadAdapters();
    console.log(`log dir:    ${LOG_DIR}`);
    console.log(`adapters:   ${adaptersManifestPath()}`);
    if (!manifest.adapters?.length) { console.log("  (none declared)"); return; }
    for (const adapter of manifest.adapters) console.log(inspectAdapter(adapter));
    return;
  }

  fail(`unknown command: ${cmd} (see --help)`);
}

main().catch((err) => {
  console.error("eventloom:", err?.message ?? err);
  process.exit(1);
});
