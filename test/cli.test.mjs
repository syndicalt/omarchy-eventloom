// End-to-end through the real entry point, against a throwaway HOME.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { localDay } from "../lib/paths.mjs";

const CLI = fileURLToPath(new URL("../lib/eventloom.mjs", import.meta.url));
const hooks = JSON.parse(readFileSync(new URL("./fixtures/claude-hooks.json", import.meta.url), "utf8"));

const sandboxes = [];
after(() => {
  for (const home of sandboxes) {
    chmodSync(path.join(home, "logs"), 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

function sandbox() {
  const home = mkdtempSync(path.join(tmpdir(), "eventloom-cli-"));
  sandboxes.push(home);
  const logs = path.join(home, "logs");
  mkdirSync(logs, { mode: 0o700 });
  const run = (args, { input = "", env = {} } = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      input,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, EVENTLOOM_LOG_DIR: logs, ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const tail = (...args) => run(["tail", ...args]).stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { home, logs, run, tail, today: path.join(logs, `${localDay()}.jsonl`) };
}

test("append redacts before sealing, and tail and verify read it back", () => {
  const { run, tail } = sandbox();
  const appended = run(["append", "agent.note.added", "--actor", "me", "--correlation", "goal-1",
    "--payload", '{"text":"deploy with password=hunter2","api_key":"abcd1234"}']);
  assert.equal(appended.status, 0, appended.stderr);
  assert.match(JSON.parse(appended.stdout).hash, /^sha256:/);

  const [event] = tail("--actor", "me");
  assert.deepEqual(event.payload, { text: "deploy with password=[REDACTED]", api_key: "[REDACTED]", correlation_id: "goal-1" });
  const verified = run(["verify"]);
  assert.equal(verified.status, 0);
  assert.equal(JSON.parse(verified.stdout).ok, true);
});

test("usage errors exit 1 with one line and write nothing", () => {
  const { run, tail } = sandbox();
  const cases = [
    [["append"], /requires an event type/],
    [["append", "agent.note.added", "--payload", "{"], /--payload is not valid JSON/],
    [["append", "agent.note.added", "--payload", "[]"], /payload is not a JSON object/],
    [["append", "agent.note.added", "--bogus"], /Unknown option '--bogus'$/],
    [["append", "agent.note.added", "extra"], /unexpected argument: extra/],
    [["append", "agent.note.added", "--actor"], /--actor/],
    [["append", "agent.tool_call.started"], /is not an event type/],
    [["append", "eventloom.shard.anchored"], /written by eventloom itself/],
    [["tail", "--limit", "abc"], /non-negative integer/],
    [["tail", "--limit", ""], /non-negative integer/],
    [["recover", "--log", "/nonexistent.jsonl"], /log not found/],
    [["wire-claude-hooks", "/elsewhere/hook.sh"], /unexpected argument/],
    [["tail", "--limit", "-1"], /non-negative integer|ambiguous/],
    [["verify", "--log", "/nonexistent.jsonl"], /log not found/],
    [["frobnicate"], /unknown command: frobnicate/],
  ];
  for (const [args, message] of cases) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr.trim(), message, args.join(" "));
    assert.equal(result.stderr.trim().split("\n").length, 1, args.join(" "));
  }
  assert.deepEqual(tail(), []);
});

test("tail --limit 0 prints nothing and tail survives a damaged line", () => {
  const { run, tail, today } = sandbox();
  run(["append", "agent.note.added", "--payload", '{"n":1}']);
  appendFileSync(today, "{torn\n");
  assert.deepEqual(tail("--limit", "0"), []);
  const result = run(["tail"]);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /skipped damaged line .*:3/);
  assert.equal(result.stdout.trim().split("\n").length, 2);
});

test("verify exits 2 on a damaged shard and recover makes the log writable again", () => {
  const { run, today } = sandbox();
  run(["append", "agent.note.added", "--payload", '{"n":1}']);
  appendFileSync(today, "{torn\n");
  assert.equal(run(["verify"]).status, 2);
  assert.equal(run(["append", "agent.note.added"]).status, 1);

  const recovered = JSON.parse(run(["recover"]).stdout);
  assert.equal(recovered.keptEvents, 2);
  assert.equal(run(["append", "agent.note.added"]).status, 0);
  assert.equal(run(["verify"]).status, 0);
});

test("ingest writes the good lines and reports the bad ones in the error log", () => {
  const { run, tail, logs } = sandbox();
  const lines = [
    JSON.stringify({ type: "agent.tool.started", actor: "omp", thread: "omp-1", payload: { tool: "bash" } }),
    "not json",
    JSON.stringify({ type: "agent.tool_call.started", actor: "omp", payload: {} }),
    JSON.stringify({ type: "agent.tool.completed", actor: "omp", thread: "omp-1", payload: { tool: "bash" } }),
  ];
  const result = run(["ingest"], { input: `${lines.join("\n")}\n` });
  assert.equal(result.status, 1);
  assert.deepEqual(tail("--actor", "omp").map((event) => event.type), ["agent.tool.started", "agent.tool.completed"]);
  assert.match(readFileSync(path.join(logs, "..", "eventloom-errors.log"), "utf8"), /\tingest\trejected 2 event\(s\): line 2: .*; line 3: /);
});

test("free text ending in a backslash is recorded, alone or in a batch", () => {
  const { run, tail } = sandbox();
  const awkward = { text: "export DB_PASSWORD=\\" };
  assert.equal(run(["append", "agent.note.added", "--payload", JSON.stringify(awkward)]).status, 0);
  const lines = [
    { type: "agent.note.added", actor: "a", payload: { text: "one" } },
    { type: "agent.note.added", actor: "a", payload: awkward },
    { type: "agent.note.added", actor: "a", payload: { text: "three" } },
  ];
  assert.equal(run(["ingest"], { input: lines.map((line) => JSON.stringify(line)).join("\n") }).status, 0);
  assert.deepEqual(tail("--actor", "a").map((event) => event.payload.text), ["one", "export DB_PASSWORD=[REDACTED]", "three"]);
});

test("claude-hook records session and tool hooks and ignores Stop", () => {
  const { run, tail } = sandbox();
  for (const name of ["SessionStart", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]) {
    assert.equal(run(["claude-hook"], { input: JSON.stringify(hooks[name]) }).status, 0, name);
  }
  const events = tail("--actor", "claude");
  assert.deepEqual(events.map((event) => event.type), [
    "agent.session.started", "agent.tool.completed", "agent.tool.failed", "agent.session.completed",
  ]);
  assert.equal(events[0].payload.host.length > 0, true, "session start carries provenance");
  assert.doesNotMatch(JSON.stringify(events), /netrc|hunter2/);
});

test("session starts carry the Omarchy release reported by omarchy-version", () => {
  const { run, tail, home } = sandbox();
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "omarchy-version"), "#!/bin/sh\necho 9.9.9-1\n", { mode: 0o755 });
  run(["claude-hook"], { input: JSON.stringify(hooks.SessionStart), env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(tail().at(-1).payload.omarchy, "9.9.9-1");
});

test("rejected input is redacted before it reaches the error log", () => {
  const { run, logs } = sandbox();
  run(["ingest"], { input: '{"type":"deploy password=hunter2 now","actor":"x"}\n' });
  const errors = readFileSync(path.join(logs, "..", "eventloom-errors.log"), "utf8");
  assert.match(errors, /password=\[REDACTED\]/);
  assert.doesNotMatch(errors, /hunter2/);
});

test("purge deletes a day and verify treats the gap as acknowledged", () => {
  const { run, logs, today } = sandbox();
  const old = path.join(logs, "2026-01-01.jsonl");
  run(["append", "agent.note.added", "--log", old]);
  run(["append", "agent.note.added"]);
  assert.match(readFileSync(today, "utf8"), /"previous_shard":"2026-01-01\.jsonl"/);

  assert.equal(run(["purge", "2026-01-01"]).status, 0);
  assert.equal(existsSync(old), false);
  const verified = run(["verify"]);
  assert.equal(verified.status, 0, verified.stdout);
  assert.match(verified.stdout, /acknowledged_gap/);
  const doctor = run(["doctor"]);
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.match(doctor.stdout, /ok +integrity +1 shard\(s\), \d+ event\(s\), 1 with an acknowledged gap$/m);
  assert.equal(JSON.parse(run(["purge", "2026-01-01"]).stdout).deleted, false, "already gone: recorded again, nothing to delete");
  assert.match(run(["purge", "yesterday"]).stderr, /purge requires a day/);
  assert.match(run(["purge", "2026-13-45"]).stderr, /purge requires a day/);
});

test("claude-hook failures are recorded, since Claude discards the hook's output", () => {
  const { run, logs } = sandbox();
  assert.equal(run(["claude-hook"], { input: "not json" }).status, 1);
  assert.match(readFileSync(path.join(logs, "..", "eventloom-errors.log"), "utf8"), /\tclaude-hook\t/);
});

test("EVENTLOOM_DISABLE=1 makes the adapter entry points record nothing", () => {
  const { run, tail } = sandbox();
  const env = { EVENTLOOM_DISABLE: "1" };
  assert.equal(run(["claude-hook"], { input: JSON.stringify(hooks.SessionStart), env }).status, 0);
  assert.equal(run(["ingest"], { input: '{"type":"agent.note.added","actor":"x"}\n', env }).status, 0);
  assert.deepEqual(tail(), []);
});

test("many processes meeting an orphaned lock all get their event in", async () => {
  const { run, tail, logs, today } = sandbox();
  run(["append", "agent.note.added"]);
  writeFileSync(`${today}.lock`, "");
  utimesSync(`${today}.lock`, 0, 0);

  const env = { PATH: process.env.PATH, HOME: path.dirname(logs), EVENTLOOM_LOG_DIR: logs };
  const exits = await Promise.all(Array.from({ length: 12 }, (_, index) => new Promise((resolve) => {
    spawn(process.execPath, [CLI, "append", "agent.note.added", "--actor", "racer", "--payload", `{"n":${index}}`], { env, stdio: "ignore" })
      .on("close", resolve);
  })));
  assert.deepEqual(exits, Array(12).fill(0));
  assert.equal(tail("--actor", "racer", "--limit", "50").length, 12);
  assert.equal(run(["verify"]).status, 0);
  assert.equal(existsSync(`${today}.lock`), false);
});

test("metadata mode keeps structure and drops content; a bad mode refuses to write", () => {
  const { run, tail } = sandbox();
  const args = ["append", "agent.note.added", "--payload", '{"text":"private","tool":"bash"}'];
  run(args, { env: { EVENTLOOM_MODE: "metadata" } });
  assert.deepEqual(tail().at(-1).payload, { tool: "bash" });
  const refused = run(args, { env: { EVENTLOOM_MODE: "metdata" } });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /EVENTLOOM_MODE must be one of/);
});

test("wire-claude-hooks refuses an unparseable settings file and leaves it untouched", () => {
  const { run, home } = sandbox();
  const settings = path.join(home, ".claude", "settings.json");
  mkdirSync(path.dirname(settings));
  const jsonc = '{\n  // keep me\n  "permissions": {"deny": ["Read(.env)"]},\n}\n';
  writeFileSync(settings, jsonc);
  const refused = run(["wire-claude-hooks"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not valid JSON.*left unchanged/);
  assert.equal(readFileSync(settings, "utf8"), jsonc);
});

test("wire then unwire returns settings.json to what it was", () => {
  const { run, home } = sandbox();
  const settings = path.join(home, ".claude", "settings.json");
  mkdirSync(path.dirname(settings));
  const original = `${JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "herdr stop" }] }] } }, null, 2)}\n`;
  writeFileSync(settings, original);

  assert.equal(JSON.parse(run(["wire-claude-hooks"]).stdout).changed, true);
  assert.equal(JSON.parse(run(["wire-claude-hooks"]).stdout).changed, false);
  assert.match(readFileSync(settings, "utf8"), /sh '.*\/\.claude\/hooks\/eventloom-hook\.sh'/);
  assert.equal(JSON.parse(run(["unwire-claude-hooks"]).stdout).removed, 4);
  assert.equal(readFileSync(settings, "utf8"), original);
});

test("unwire with nothing to remove leaves the file's bytes alone", () => {
  const { run, home } = sandbox();
  const settings = path.join(home, ".claude", "settings.json");
  mkdirSync(path.dirname(settings));
  const tabbed = '{\n\t"model": "opus"\n}';
  writeFileSync(settings, tabbed);
  assert.equal(JSON.parse(run(["unwire-claude-hooks"]).stdout).removed, 0);
  assert.equal(readFileSync(settings, "utf8"), tabbed);
  assert.equal(existsSync(`${settings}.eventloom-backup`), false);
});

test("doctor passes on a fresh machine and fails on a damaged log", () => {
  const { run, today } = sandbox();
  const fresh = run(["doctor"]);
  assert.equal(fresh.status, 0, fresh.stdout);
  assert.match(fresh.stdout, /ok +runtime +sealed and verified a probe event/);
  assert.match(fresh.stdout, /ok +adapter: claude +agent not present/);

  run(["append", "agent.note.added"]);
  appendFileSync(today, "{torn\n");
  const damaged = run(["doctor"]);
  assert.equal(damaged.status, 1);
  assert.match(damaged.stdout, /fail +integrity/);

});

test("doctor fails when the log directory cannot be written", { skip: process.getuid?.() === 0 }, (t) => {
  const { run, logs } = sandbox();
  run(["append", "agent.note.added"]);
  chmodSync(logs, 0o500);
  t.after(() => chmodSync(logs, 0o700));
  const result = run(["doctor"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fail +log directory .*not writable/);
});
