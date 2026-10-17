#!/usr/bin/env node
// eventloom — the command-line front of the Omarchy agent event log.
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { codexHookToEvent } from "./codex-hook.mjs";
import { runAgent } from "./run-agent.mjs";
import { agentCapabilities } from "./agents.mjs";
import { codexHookPath, codexSettingsPath, unwireCodexHooks, wireCodexHooks } from "./codex-settings.mjs";
import { NATIVE_HOOKS, nativeHookPaths, nativeHookResponse, nativeHookToEvent, unwireNativeHooks, wireNativeHooks } from "./native-hooks.mjs";
import { claudeHookToEvent } from "./claude-hook.mjs";
import {
  claudeSettingsPath, readSettingsFile, unwireClaudeHooks, wireClaudeHooks, writeSettingsFile,
} from "./claude-settings.mjs";
import { SETTING_NAMES, describeSettings, getSetting, setSetting } from "./config.mjs";
import { runDoctor } from "./doctor.mjs";
import { recordError } from "./error-log.mjs";
import {
  BRIEF_SUMMARIES, RECALL_DAYS, briefing, briefingSummaries, memoryEnabled, projectOf, recallDraft, recallSummaries,
  sessionFromEnv,
  summaryDraft, summaryLine,
} from "./memory.mjs";
import { shardPath } from "./paths.mjs";
import { captureMode } from "./redact.mjs";
import { draftFromAdapter, prepareEvent, recordEvents, sealEvents } from "./record.mjs";
import { purgeShard, readRecentEvents, recoverShards, verifyShards } from "./store.mjs";

const HELP = `eventloom — universal append-only agent event log for Omarchy

Usage:
  eventloom append <event.type> [--actor <id>] [--thread <id>] [--payload '<json>']
                   [--correlation <id>] [--cwd <path>] [--log <path>]
  eventloom note [--tags a,b]         record a summary of a reply (read from stdin)
  eventloom recall [--limit 8] [--days 30|all] [--tag <tag>] [--correlation <id>]
                   [--cwd <path>] [--all] [--json]
                                      summaries recorded for this project, or all of them
  eventloom tail [--limit N] [--actor <id>] [--log <path>]
  eventloom verify [--log <path>]     every daily shard and the links between them
  eventloom recover [--log <path>]    set a damaged shard aside, keep its verified prefix
  eventloom purge <YYYY-MM-DD>        delete one day's shard and record that it was
  eventloom doctor                    log health and adapter wiring (alias: inspect)
  eventloom run <agent> [-- <args>...] process start/exit coverage for any Omarchy agent
  eventloom agents [--json]           coverage inventory for Omarchy's agents
  eventloom path                      today's shard
  eventloom tapestry [--port N] [--days 7|all] [--correlation <goal-id>] [--demo]
  eventloom config [get <key> | set <key> <value>]
                                      remembered settings: ${SETTING_NAMES.join(", ")}
  eventloom wire-claude-hooks         register ~/.claude/hooks/eventloom-hook.sh
  eventloom unwire-claude-hooks
  eventloom wire-codex-hooks         register Codex hooks (review them in Codex /hooks)
  eventloom unwire-codex-hooks
  eventloom wire-native-hooks --agent <id>
  eventloom unwire-native-hooks --agent <id>

Adapter entry points (read stdin):
  eventloom ingest                    one {"type","actor","thread","payload"} object per line
  eventloom claude-hook               one Claude Code hook input
  eventloom codex-hook                one Codex command-hook input
  eventloom native-hook --agent <id> --event <name>
  eventloom brief --actor <id> --session <id> [--cwd <path>]
                                      what a session is told as it opens

Log: ~/.local/state/omarchy/agents/logs/YYYY-MM-DD.jsonl (local date, hash-chained)
Environment:
  EVENTLOOM_MODE=full|summary|metadata   how much of each payload is kept
  EVENTLOOM_DISABLE=1                    ingest and claude-hook record nothing
  EVENTLOOM_MEMORY=0|1                   overrides the memory setting for one process
  EVENTLOOM_CORRELATION_ID               joins an agent's sessions to a shared task
  EVENTLOOM_LOG_DIR                      keep the log somewhere else
  EVENTLOOM_TAPESTRY_PORT                overrides the tapestry_port setting
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

// Summaries are content, and metadata mode keeps none.
function memoryKept() {
  return captureMode() !== "metadata";
}

function positiveInteger(name, text) {
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be a positive whole number`);
  return Number(text);
}

async function note(argv) {
  const { values } = parse(argv, {
    tags: { type: "string" },
    actor: { type: "string" },
    session: { type: "string" },
    correlation: { type: "string" },
    cwd: { type: "string" },
  });
  if (process.stdin.isTTY) throw new Error("note reads the summary from standard input, e.g. eventloom note <<'EOF'");
  const draft = draftFromAdapter(summaryDraft({ ...values, text: await readStdin() }));
  if (!memoryKept()) {
    console.log("not recorded: EVENTLOOM_MODE=metadata keeps no content");
    return;
  }
  const [sealed] = await recordEvents([draft]);
  print({ id: sealed.id, type: sealed.type, project: sealed.payload.project });
}

// Hands a session the summaries for its project, and records that it did.
async function recallFor({ actor, session, cwd, summaries }) {
  if (summaries.length && (session || sessionFromEnv())) {
    await recordEvents([draftFromAdapter(recallDraft(summaries, { actor, session, cwd }))]);
  }
}

async function recall(argv) {
  const { values } = parse(argv, {
    limit: { type: "string", default: String(BRIEF_SUMMARIES) },
    days: { type: "string", default: String(RECALL_DAYS) },
    tag: { type: "string" },
    correlation: { type: "string" },
    cwd: { type: "string" },
    all: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  });
  const summaries = recallSummaries({
    project: values.all || values.correlation ? undefined : projectOf(values.cwd),
    correlation: values.correlation,
    tag: values.tag,
    limit: positiveInteger("--limit", values.limit),
    days: values.days === "all" ? null : positiveInteger("--days", values.days),
  });
  for (const event of summaries) {
    if (values.json) print({ id: event.id, ts: event.payload.occurred_at ?? event.timestamp, actor: event.actorId, ...event.payload });
    else console.log(summaryLine(event));
  }
  if (!summaries.length && !values.json) console.log("nothing recorded");
  await recallFor({ cwd: values.cwd, summaries });
}

async function briefSession({ actor, session, cwd }) {
  if (!memoryEnabled() || !memoryKept()) return;
  const project = projectOf(cwd);
  const found = briefingSummaries(project);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const note = ["omp", "claude"].includes(actor) ? "eventloom note"
    : `eventloom note --actor ${quote(actor)} --session ${quote(session)}`;
  console.log(briefing(found, project, note));
  await recallFor({ actor, session, cwd, summaries: [...(found.first ? [found.first] : []), ...found.latest] });
}

async function brief(argv) {
  const { values } = parse(argv, {
    actor: { type: "string" },
    session: { type: "string" },
    cwd: { type: "string" },
  });
  if (!values.actor || !values.session) throw new Error("brief requires --actor and --session");
  await briefSession(values);
}

// A SessionStart hook's standard output is added to the session's context,
// so that is where the briefing goes. Other hooks print nothing.
async function claudeHook(argv) {
  parse(argv, {});
  const hook = JSON.parse(await readStdin());
  const draft = claudeHookToEvent(hook);
  if (!draft) return;
  await recordEvents([draft]);
  if (hook.hook_event_name === "SessionStart") {
    await briefSession({ actor: "claude", session: hook.session_id, cwd: hook.cwd });
  }
}

async function codexHook(argv) {
  parse(argv, {});
  let hook;
  try { hook = JSON.parse(await readStdin()); }
  catch { throw new Error("Codex hook input is not valid JSON"); }
  const draft = codexHookToEvent(hook);
  if (!draft) return;
  await recordEvents([draft]);
  let response = {};
  if (hook.hook_event_name === "SessionStart" && memoryEnabled() && memoryKept()) {
    const project = projectOf(hook.cwd);
    const found = briefingSummaries(project);
    // Explicit attribution works even when Codex does not export a session
    // environment variable to its tools. Quote the id as shell data.
    const session = "'" + hook.session_id.replaceAll("'", "'\\''") + "'";
    const context = briefing(found, project, `eventloom note --actor codex --session ${session}`);
    await recallFor({ actor: "codex", session: hook.session_id, cwd: hook.cwd,
      summaries: [...(found.first ? [found.first] : []), ...found.latest] });
    response = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
  }
  print(response);
}

async function nativeHook(argv) {
  const { values } = parse(argv, { agent: { type: "string" }, event: { type: "string" } });
  let hook;
  try { hook = JSON.parse(await readStdin()); }
  catch { throw new Error("Native hook input is not valid JSON"); }
  const draft = nativeHookToEvent(values.agent, values.event, hook);
  await recordEvents([draft]);
  let context;
  if (values.event === "SessionStart" && NATIVE_HOOKS[values.agent].memory && memoryEnabled() && memoryKept()) {
    const { session_id: session, cwd } = draft.payload;
    const project = projectOf(cwd), found = briefingSummaries(project);
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    context = briefing(found, project, `eventloom note --actor ${quote(values.agent)} --session ${quote(session)}`);
    await recallFor({ actor: values.agent, session, cwd, summaries: [...(found.first ? [found.first] : []), ...found.latest] });
  }
  print(nativeHookResponse(values.agent, values.event, context));
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

function wireCodex(argv) {
  parse(argv, {});
  const file = codexSettingsPath();
  const changed = writeSettingsFile(file, wireCodexHooks(readSettingsFile(file)));
  print({ ok: true, settings: file, hook: codexHookPath(), changed, review: "Review and trust Eventloom's hooks in Codex /hooks before they run" });
}
function unwireCodex(argv) {
  parse(argv, {});
  const file = codexSettingsPath();
  const { settings, removed } = unwireCodexHooks(readSettingsFile(file));
  if (removed) writeSettingsFile(file, settings);
  print({ ok: true, settings: file, removed });
}

function configureNative(argv, remove = false) {
  const { values } = parse(argv, { agent: { type: "string" }, "if-present": { type: "boolean" } });
  const agent = values.agent, paths = nativeHookPaths(agent);
  if (values["if-present"] && !existsSync(paths.home)) return;
  const original = readSettingsFile(paths.config);
  const { settings, removed } = remove ? unwireNativeHooks(original, agent)
    : { settings: wireNativeHooks(original, agent), removed: 0 };
  const changed = (!remove || removed) ? writeSettingsFile(paths.config, settings) : false;
  // On uninstall, keep the neutral shell wrapper if a user-owned command
  // still references it. It remains safe when the CLI has been removed.
  if (remove && JSON.stringify(settings).includes("eventloom-native-hook.sh")) throw new Error(`${agent} still references the native hook script; its script must be kept`);
  print({ ok: true, agent, settings: paths.config, changed, removed });
}

function config(argv) {
  const { positionals: [action, key, value] } = parse(argv, {}, 3);
  if (action === undefined) {
    for (const line of describeSettings()) console.log(line);
  } else if (action === "get" && key !== undefined && value === undefined) {
    console.log(getSetting(key));
  } else if (action === "set" && value !== undefined) {
    console.log(`${key}=${setSetting(key, value)}`);
  } else {
    throw new Error("usage: eventloom config [get <key> | set <key> <value>]");
  }
}

async function tapestry(argv) {
  const { main } = await import("../tapestry/server.mjs");
  if (!main(argv)) return;
  // leave through `exit`, where the server removes its launch page
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => process.exit(0));
}

const COMMANDS = {
  agents: (argv) => {
    const { values } = parse(argv, { json: { type: "boolean" } });
    const agents = agentCapabilities();
    if (values.json) print(agents);
    else {
      console.log("All agents: process capture through eventloom run <agent> [-- <args>...]");
      for (const item of agents) console.log(`${item.agent.padEnd(14)} ${(item.native ?? "process only").padEnd(14)} memory: ${item.automatic_memory ? "opt-in" : "manual"} — ${item.notes}`);
    }
  },
  run: async ([agent, ...args]) => {
    // Everything after the agent name belongs to the child. Never shell-
    // interpolate or interpret model prompts/agent flags as Eventloom flags.
    if (args[0] === "--") args.shift();
    process.exitCode = await runAgent(agent, args);
  },
  append,
  ingest,
  "claude-hook": claudeHook,
  "codex-hook": codexHook,
  "native-hook": nativeHook,
  note,
  recall,
  brief,
  tail,
  verify,
  recover,
  purge,
  doctor,
  inspect: doctor,
  path: (argv) => { parse(argv, {}); console.log(shardPath()); },
  tapestry,
  config,
  "wire-claude-hooks": wireClaude,
  "unwire-claude-hooks": unwireClaude,
  "wire-codex-hooks": wireCodex,
  "unwire-codex-hooks": unwireCodex,
  "wire-native-hooks": (argv) => configureNative(argv),
  "unwire-native-hooks": (argv) => configureNative(argv, true),
};

// These run with their output discarded by the agent that invoked them.
const ADAPTER_COMMANDS = new Set(["ingest", "claude-hook", "codex-hook", "native-hook", "brief"]);

async function main([command, ...argv]) {
  if (!command || command === "--help" || command === "-h" || (command !== "run" || argv.length === 1) && argv.includes("--help")) {
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
