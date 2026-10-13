// Summaries and their recall, end to end through the real entry point.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SUMMARY_LIMIT } from "../lib/memory.mjs";
import { deriveLinks, weaveSpec } from "../tapestry/server.mjs";
import { tempDir } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../lib/eventloom.mjs", import.meta.url));

// A machine with two projects that are not git repositories, so a project is
// its directory.
function sandbox(t) {
  const home = tempDir(t, "memory");
  const logs = path.join(home, "logs");
  const projects = { loom: path.join(home, "loom"), other: path.join(home, "other") };
  for (const dir of [logs, ...Object.values(projects)]) mkdirSync(dir, { mode: 0o700 });
  const run = (args, { input = "", env = {} } = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      input,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, EVENTLOOM_LOG_DIR: logs, ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const events = () => run(["tail", "--limit", "50"]).stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const as = (actor, session) => ({ EVENTLOOM_ACTOR: actor, EVENTLOOM_SESSION_ID: session });
  return { projects, run, events, as };
}

test("a summary is filed under its project and session, redacted, and read back", (t) => {
  const { projects, run, events, as } = sandbox(t);
  const noted = run(["note", "--tags", "Release, db", "--cwd", projects.loom], {
    input: "Moved the  migration behind a flag;\npassword=hunter2 was in the old script.\n",
    env: as("omp", "s1"),
  });
  assert.equal(noted.status, 0, noted.stderr);
  assert.equal(JSON.parse(noted.stdout).project, projects.loom);
  run(["note", "--cwd", projects.other], { input: "Unrelated work.", env: { CLAUDE_CODE_SESSION_ID: "c9" } });

  const [first, second] = events().filter((event) => event.type === "agent.reply.summarized");
  assert.equal(first.actor, "omp");
  assert.equal(first.thread, "omp-s1");
  assert.deepEqual(
    { ...first.payload, occurred_at: undefined },
    {
      correlation_id: "omp-s1", occurred_at: undefined, cwd: projects.loom, project: projects.loom, session_id: "s1",
      summary: "Moved the migration behind a flag; password=[REDACTED] was in the old script.", tags: ["release", "db"],
    },
  );
  assert.equal(second.actor, "claude", "Claude Code names its session in the environment");
  assert.equal(second.payload.session_id, "c9");

  const recalled = run(["recall", "--cwd", projects.loom]);
  assert.match(recalled.stdout, /^- \d{4}-\d\d-\d\d \d\d:\d\d omp \[release, db\]: Moved the migration behind a flag/);
  assert.doesNotMatch(recalled.stdout, /Unrelated/);
  assert.match(run(["recall", "--all"]).stdout, /Unrelated work\./);
  assert.match(run(["recall", "--all", "--tag", "db"]).stdout, /^- .*Moved the migration.*\n$/);
  assert.equal(run(["recall", "--cwd", projects.loom, "--tag", "nope"]).stdout, "nothing recorded\n");
  assert.equal(JSON.parse(run(["recall", "--cwd", projects.loom, "--json"]).stdout).summary, first.payload.summary);
  assert.equal(run(["verify"]).status, 0);
});

test("a recall by a session is recorded, naming what it was given", (t) => {
  const { projects, run, events, as } = sandbox(t);
  const ids = ["one", "two"].map((text) => JSON.parse(run(["note", "--cwd", projects.loom], { input: text, env: as("omp", "s1") }).stdout).id);

  run(["recall", "--cwd", projects.loom]);
  assert.equal(events().some((event) => event.type === "agent.memory.recalled"), false, "nobody to attribute it to");
  run(["recall", "--cwd", projects.other], { env: as("claude", "s2") });
  assert.equal(events().some((event) => event.type === "agent.memory.recalled"), false, "nothing was handed over");

  run(["recall", "--cwd", projects.loom], { env: as("claude", "s2") });
  const recall = events().find((event) => event.type === "agent.memory.recalled");
  assert.equal(recall.thread, "claude-s2");
  assert.deepEqual(recall.payload.recalled, ids);
  assert.equal(recall.payload.count, 2);
});

test("what is not a summary is refused, and metadata mode keeps none", (t) => {
  const { run, events } = sandbox(t);
  const refused = [
    [{ input: "  \n" }, /note needs a summary on standard input/],
    [{ input: "x".repeat(SUMMARY_LIMIT + 1) }, new RegExp(`the summary is ${SUMMARY_LIMIT + 1} characters; say it in ${SUMMARY_LIMIT} or fewer`)],
  ];
  for (const [options, message] of refused) {
    const result = run(["note"], options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
  assert.match(run(["note", "--tags", "Not A Tag"], { input: "x" }).stderr, /"not a tag" is not a tag/);
  assert.match(run(["note", "--tags", "a,b,c,d,e,f"], { input: "x" }).stderr, /at most 5 tags/);
  assert.match(run(["note", "words"], { input: "x" }).stderr, /unexpected argument: words/);
  assert.match(run(["recall", "--limit", "0"]).stderr, /--limit must be a positive whole number/);

  const metadata = run(["note"], { input: "kept nowhere", env: { EVENTLOOM_MODE: "metadata" } });
  assert.equal(metadata.status, 0);
  assert.match(metadata.stdout, /not recorded: EVENTLOOM_MODE=metadata keeps no content/);
  assert.deepEqual(events(), []);
});

test("a session is briefed as it opens, and only then", (t) => {
  const { projects, run, events, as } = sandbox(t);
  const hook = (input, env) => run(["claude-hook"], { input: JSON.stringify({ session_id: "c1", cwd: projects.loom, ...input }), env });
  const opening = { hook_event_name: "SessionStart", source: "startup" };

  const empty = hook(opening);
  assert.match(empty.stdout, /eventloom note <<'EOF'/);
  assert.match(empty.stdout, new RegExp(`Nothing has been recorded for ${projects.loom} yet\\.`));
  assert.equal(events().some((event) => event.type === "agent.memory.recalled"), false);

  const id = JSON.parse(run(["note", "--cwd", projects.loom], { input: "Chose the staged rollout.", env: as("omp", "s1") }).stdout).id;
  const briefed = hook(opening);
  assert.match(briefed.stdout, /- \d{4}-\d\d-\d\d \d\d:\d\d omp: Chose the staged rollout\./);
  const recall = events().findLast((event) => event.type === "agent.memory.recalled");
  assert.equal(recall.thread, "claude-c1");
  assert.deepEqual(recall.payload.recalled, [id]);

  assert.equal(hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }).stdout, "", "other hooks print nothing");
  assert.equal(hook(opening, { EVENTLOOM_MEMORY: "0" }).stdout, "");
  assert.equal(hook(opening, { EVENTLOOM_MODE: "metadata" }).stdout, "");
  assert.equal(hook(opening, { EVENTLOOM_DISABLE: "1" }).stdout, "");

  // the entry point the omp extension uses
  const omp = run(["brief", "--actor", "omp", "--session", "s7", "--cwd", projects.loom]);
  assert.match(omp.stdout, /Chose the staged rollout\./);
  assert.equal(events().at(-1).thread, "omp-s7");
  assert.match(run(["brief", "--actor", "omp"]).stderr, /brief requires --actor and --session/);
});

test("a long memory is briefed as its first summary and its latest eight", (t) => {
  const { projects, run, events, as } = sandbox(t);
  const ids = [];
  for (let i = 1; i <= 11; i++) {
    ids.push(JSON.parse(run(["note", "--cwd", projects.loom], { input: `summary number ${i}.`, env: as("omp", "s1") }).stdout).id);
  }
  run(["note", "--cwd", projects.other], { input: "another project's first.", env: as("omp", "s1") });

  const briefed = run(["brief", "--actor", "claude", "--session", "c1", "--cwd", projects.loom]).stdout;
  const told = [...briefed.matchAll(/summary number (\d+)\./g)].map((match) => Number(match[1]));
  assert.deepEqual(told, [1, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.match(briefed, /summary number 1\.\n {2}… \(earlier summaries left out/);
  assert.doesNotMatch(briefed, /another project/);
  assert.deepEqual(events().at(-1).payload.recalled, [ids[0], ...ids.slice(3)], "the recall names all nine");

  // with eight or fewer the first is already among them, and nothing is left out
  const short = run(["brief", "--actor", "claude", "--session", "c1", "--cwd", projects.other]).stdout;
  assert.equal(short.match(/another project's first\./g).length, 1);
  assert.doesNotMatch(short, /left out/);
});

test("the tapestry draws a memory thread from each summary to the session that recalled it", () => {
  const at = (minutes) => new Date(Date.UTC(2026, 9, 10, 8, minutes)).toISOString();
  const stitch = (id, minutes, type, session, payload = {}) => ({
    id, ts: at(minutes), type, family: "memory", actor: "omp", session, payload, causedBy: [],
  });
  const summary = "s".repeat(300);
  const stitches = [
    stitch("a", 0, "agent.reply.summarized", "one", { summary, tags: ["release", "db"], project: "/work" }),
    stitch("b", 1, "agent.reply.summarized", "one", { summary: "second" }),
    stitch("r", 2, "agent.memory.recalled", "two", { recalled: ["a", "b", "gone"], count: 3 }),
  ];
  assert.deepEqual(deriveLinks(stitches), [{ from: "a", to: "r", kind: "memory" }, { from: "b", to: "r", kind: "memory" }]);
  const spec = weaveSpec(stitches);
  assert.deepEqual(spec.stitches[0].detail, { summary, tags: "release, db", project: "/work" }, "a summary is shown whole");
  assert.deepEqual(spec.stitches[2].detail, { count: 3 });
});
