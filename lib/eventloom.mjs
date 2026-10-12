#!/usr/bin/env node
// eventloom — the command-line front of the Omarchy agent event log.
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { claudeHookToEvent } from "./claude-hook.mjs";
import {
  claudeSettingsPath, readSettingsFile, unwireClaudeHooks, wireClaudeHooks, writeSettingsFile,
} from "./claude-settings.mjs";
import { runDoctor } from "./doctor.mjs";
import { recordError } from "./error-log.mjs";
import { shardPath } from "./paths.mjs";
import { draftFromAdapter, prepareEvent, recordEvents, sealEvents } from "./record.mjs";
import { purgeShard, readRecentEvents, recoverShards, verifyShards } from "./store.mjs";

const HELP = `eventloom — universal append-only agent event log for Omarchy

Usage:
  eventloom append <event.type> [--actor <id>] [--thread <id>] [--payload '<json>']
                   [--correlation <id>] [--cwd <path>] [--log <path>]
  eventloom tail [--limit N] [--actor <id>] [--log <path>]
  eventloom verify [--log <path>]     every daily shard and the links between them
  eventloom recover [--log <path>]    set a damaged shard aside, keep its verified prefix
  eventloom purge <YYYY-MM-DD>        delete one day's shard and record that it was
  eventloom doctor                    log health and adapter wiring (alias: inspect)
  eventloom path                      today's shard
  eventloom tapestry [--port 4747] [--days 7|all] [--correlation <goal-id>] [--demo]
  eventloom wire-claude-hooks         register ~/.claude/hooks/eventloom-hook.sh
  eventloom unwire-claude-hooks

Adapter entry points (read stdin):
  eventloom ingest                    one {"type","actor","thread","payload"} object per line
  eventloom claude-hook               one Claude Code hook input

Log: ~/.local/state/omarchy/agents/logs/YYYY-MM-DD.jsonl (local date, hash-chained)
Environment:
  EVENTLOOM_MODE=full|summary|metadata   how much of each payload is kept
  EVENTLOOM_DISABLE=1                    ingest and claude-hook record nothing
  EVENTLOOM_CORRELATION_ID               joins an agent's sessions to a shared task
  EVENTLOOM_LOG_DIR                      keep the log somewhere else
Exit codes: 0 ok, 1 error, 2 log failed verification.`;

const EXIT_INTEGRITY = 2;

function parse(argv, options, maxPositionals = 0) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    // keep the first sentence; parseArgs follows it with advice about "--"
    throw new Error(err.message.split(/\.\s/)[0], { cause: err });
  }
  if (parsed.positionals.length > maxPositionals) {
    throw new Error(`unexpected argument: ${parsed.positionals[maxPositionals]}`);
  }
  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function print(value) {
  console.log(JSON.stringify(value));
}

async function append(argv) {
  const { values, positionals: [type] } = parse(argv, {
    actor: { type: "string", default: "unknown" },
    thread: { type: "string", default: "thread_main" },
    payload: { type: "string", default: "{}" },
    correlation: { type: "string" },
    cwd: { type: "string" },
    log: { type: "string" },
  }, 1);
  if (!type) throw new Error("append requires an event type, e.g. agent.note.added");
  let payload;
  try {
    payload = JSON.parse(values.payload);
  } catch (err) {
    throw new Error(`--payload is not valid JSON: ${err.message}`, { cause: err });
  }
  const draft = draftFromAdapter({ type, actor: values.actor, thread: values.thread, payload });
  if (values.correlation) draft.payload.correlation_id = values.correlation;
  if (values.cwd) draft.payload.cwd = values.cwd;
  const [sealed] = await recordEvents([draft], values.log);
  print({ id: sealed.id, type: sealed.type, hash: sealed.integrity.hash });
}

// Each line is validated and prepared on its own, so whatever is sound is
// written and one bad event cannot take a batch of good ones down with it.
async function ingest(argv) {
  parse(argv, {});
  const events = [];
  const rejected = [];
  for (const [index, line] of (await readStdin()).split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      events.push(prepareEvent(draftFromAdapter(JSON.parse(line))));
    } catch (err) {
      rejected.push(`line ${index + 1}: ${err.message}`);
    }
  }
  if (events.length) await sealEvents(events);
  if (rejected.length) throw new Error(`rejected ${rejected.length} event(s): ${rejected.join("; ")}`);
}

async function claudeHook(argv) {
  parse(argv, {});
  const draft = claudeHookToEvent(JSON.parse(await readStdin()));
  if (draft) await recordEvents([draft]);
}

function tail(argv) {
  const { values } = parse(argv, {
    limit: { type: "string", default: "20" },
    actor: { type: "string" },
    log: { type: "string" },
  });
  if (!/^\d+$/.test(values.limit)) throw new Error("--limit must be a non-negative integer");
  const limit = Number(values.limit);
  if (values.log && !existsSync(values.log)) throw new Error(`log not found: ${values.log}`);
  const byActor = values.actor ? (event) => event.actorId === values.actor : undefined;
  const { events, malformed } = readRecentEvents(limit, byActor, values.log ? [values.log] : undefined);
  for (const event of events) {
    print({ ts: event.timestamp, type: event.type, actor: event.actorId, thread: event.threadId, payload: event.payload });
  }
  for (const { shard, line } of malformed) console.error(`eventloom: skipped damaged line ${path.basename(shard)}:${line}`);
}

async function verify(argv) {
  const { values } = parse(argv, { log: { type: "string" } });
  if (values.log && !existsSync(values.log)) throw new Error(`log not found: ${values.log}`);
  const result = values.log ? await verifyShards([values.log], { checkLinks: false }) : await verifyShards();
  print({ ok: result.ok, checked: result.reports.length, reports: result.reports });
  if (!result.ok) process.exitCode = EXIT_INTEGRITY;
}

async function recover(argv) {
  const { values } = parse(argv, { log: { type: "string" } });
  if (values.log && !existsSync(values.log)) throw new Error(`log not found: ${values.log}`);
  const { recovered, failed } = await recoverShards(values.log ? [values.log] : undefined);
  for (const result of recovered) print(result);
  if (failed.length) {
    throw new Error(`could not recover ${failed.map(({ shard, message }) => `${path.basename(shard)}: ${message}`).join("; ")}`);
  }
}

async function purge(argv) {
  const { positionals: [day] } = parse(argv, {}, 1);
  // the pattern alone would let 2026-13-45 through
  const midnight = /^\d{4}-\d{2}-\d{2}$/.test(day ?? "") ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (Number.isNaN(midnight) || !new Date(midnight).toISOString().startsWith(day)) {
    throw new Error("purge requires a day, e.g. 2026-10-10");
  }
  print({ ok: true, purged: day, ...(await purgeShard(day)) });
}

async function doctor(argv) {
  parse(argv, {});
  const checks = await runDoctor();
  for (const check of checks) console.log(`${check.status.padEnd(4)}  ${check.name.padEnd(16)} ${check.detail}`);
  if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
}

function wireClaude(argv) {
  parse(argv, {});
  const settingsPath = claudeSettingsPath();
  const changed = writeSettingsFile(settingsPath, wireClaudeHooks(readSettingsFile(settingsPath)));
  print({ ok: true, settings: settingsPath, changed });
}

function unwireClaude(argv) {
  parse(argv, {});
  const settingsPath = claudeSettingsPath();
  const { settings, removed } = unwireClaudeHooks(readSettingsFile(settingsPath));
  // nothing of ours in the file: leave its bytes and formatting alone
  if (removed) writeSettingsFile(settingsPath, settings);
  print({ ok: true, settings: settingsPath, removed });
}

async function tapestry(argv) {
  const { main } = await import("../tapestry/server.mjs");
  if (!main(argv)) return;
  // leave through `exit`, where the server removes its launch page
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => process.exit(0));
}

const COMMANDS = {
  append,
  ingest,
  "claude-hook": claudeHook,
  tail,
  verify,
  recover,
  purge,
  doctor,
  inspect: doctor,
  path: (argv) => { parse(argv, {}); console.log(shardPath()); },
  tapestry,
  "wire-claude-hooks": wireClaude,
  "unwire-claude-hooks": unwireClaude,
};

// These run with their output discarded by the agent that invoked them.
const ADAPTER_COMMANDS = new Set(["ingest", "claude-hook"]);

async function main([command, ...argv]) {
  if (!command || command === "--help" || command === "-h" || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  // The opt-out is honoured here too, so every adapter gets it for free.
  if (ADAPTER_COMMANDS.has(command) && process.env.EVENTLOOM_DISABLE === "1") return;
  try {
    if (!run) throw new Error(`unknown command: ${command} (see --help)`);
    await run(argv);
  } catch (err) {
    if (ADAPTER_COMMANDS.has(command)) recordError(command, err.message);
    console.error(`eventloom: ${err.message}`);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
