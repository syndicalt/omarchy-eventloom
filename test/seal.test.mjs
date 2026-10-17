// Sealed mode end to end: the real CLI, and the real helper pointed at a
// scratch directory and run directly, since a test has no second user.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { localDay } from "../lib/paths.mjs";
import { tempDir } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../lib/eventloom.mjs", import.meta.url));
const HELPER = fileURLToPath(new URL("../seal/eventloom-seal", import.meta.url));
const UID = process.getuid();

function sandbox(t, { sealed = true, sealOf } = {}) {
  const home = tempDir(t, "sealed");
  const logs = path.join(home, "logs");
  const sealDir = path.join(home, "seal");
  mkdirSync(logs, { mode: 0o700 });
  mkdirSync(sealDir);
  const helper = path.join(home, "eventloom-seal");
  writeFileSync(helper, readFileSync(HELPER, "utf8").replace(/^SEAL_DIR=.*$/m, `SEAL_DIR=${sealDir}`));
  chmodSync(helper, 0o755);
  const sealFile = path.join(sealDir, `${UID}.evtseal`);
  if (sealed) writeFileSync(sealFile, `eventloom-seal 1 uid=${UID} log=${sealOf ?? logs}\n`);
  const env = { PATH: process.env.PATH, HOME: home, EVENTLOOM_LOG_DIR: logs, EVENTLOOM_SEAL_DIR: sealDir, EVENTLOOM_SEAL_HELPER: helper };
  const run = (args, { input = "", env: extra = {} } = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", env: { ...env, ...extra } });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const today = path.join(logs, `${localDay()}.jsonl`);
  return {
    run, today, logs, sealFile, helper,
    add: (count, type = "agent.note.added") => { for (let i = 0; i < count; i++) run(["append", type, "--actor", "t"]); },
    seals: () => readFileSync(sealFile, "utf8").trimEnd().split("\n").slice(1).map((line) => line.split(" ").slice(2, 5).join(" ")),
    verify: () => { const result = run(["verify"]); return { status: result.status, ...JSON.parse(result.stdout) }; },
    lines: () => readFileSync(today, "utf8").split("\n").filter(Boolean),
  };
}

test("the log is sealed every ten events and at a session's edges", (t) => {
  const { add, seals, verify } = sandbox(t);
  const day = localDay();
  add(8); // with the shard's anchor, nine events: not yet
  assert.deepEqual(seals(), []);
  add(1);
  assert.deepEqual(seals(), [`head ${day} 10`]);
  add(3);
  add(1, "agent.session.completed");
  assert.deepEqual(seals(), [`head ${day} 10`, `head ${day} 14`], "a session ending is sealed at once");
  add(2);

  const result = verify();
  assert.equal(result.ok, true);
  assert.equal(result.seal.records, 2);
  assert.equal(result.seal.unsealedEvents, 2);
  assert.deepEqual(result.seal.errors, []);
});

test("cutting events off the end is caught, which the chain alone cannot do", (t) => {
  const { add, verify, today, lines, run } = sandbox(t);
  add(12);
  const kept = lines().slice(0, 6);
  writeFileSync(today, `${kept.join("\n")}\n`);

  const result = verify();
  assert.equal(result.reports[0].ok, true, "the shortened shard is a valid chain in itself");
  assert.equal(result.ok, false);
  assert.equal(result.status, 2);
  assert.deepEqual(result.seal.errors.map((error) => error.code), ["seal_mismatch"]);
  assert.match(result.seal.errors[0].message, /was sealed at event 10 on .*; the shard has 6/);
  assert.match(run(["doctor"]).stdout, /fail +integrity +.*the log does not match its seal: .*sealed at event 10/);
  const status = run(["seal", "status"]);
  assert.equal(status.status, 2);
  assert.match(status.stdout, /FAILED: .*sealed at event 10/);
});

test("a rewritten log with every hash recomputed is caught", (t) => {
  const { add, verify, today, logs, run } = sandbox(t);
  add(10);
  // the forger's move: throw the day away and write a new, internally valid one
  writeFileSync(today, "");
  const forged = spawnSync(process.execPath, [CLI, "append", "agent.note.added", "--actor", "t", "--log", today], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: logs, EVENTLOOM_LOG_DIR: path.join(logs, "elsewhere") },
  });
  assert.equal(forged.status, 0, forged.stderr);
  for (let i = 0; i < 10; i++) run(["append", "agent.note.added", "--actor", "t"], { env: { EVENTLOOM_SEAL_DIR: path.join(logs, "no-seal") } });

  const result = verify();
  assert.equal(result.reports.every((report) => report.ok), true, "every hash in the forgery is right");
  assert.equal(result.ok, false);
  assert.match(result.seal.errors[0].message, /sealed at event 10 .*; it has changed/);
});

test("a deleted day that was sealed is caught, and a purged one is on record for good", (t) => {
  const day = localDay();
  const deleted = sandbox(t);
  deleted.add(10);
  rmSync(deleted.today);
  const missing = deleted.verify();
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.seal.errors.map((error) => error.code), ["sealed_shard_missing"]);

  const purged = sandbox(t);
  purged.add(10);
  assert.equal(purged.run(["purge", day]).status, 0);
  assert.deepEqual(purged.seals().slice(0, 2), [`head ${day} 10`, `ack ${day} 0`]);
  const after = purged.verify();
  assert.equal(after.ok, true, JSON.stringify(after.seal));
  assert.match(after.seal.warnings[0].message, new RegExp(`${day} was purged at .*, keeping 0 event\\(s\\)`));
});

test("recover records how much it kept, and the kept part is still held to its seal", (t) => {
  const { add, verify, today, lines, run, seals } = sandbox(t);
  const day = localDay();
  add(11);
  const all = lines();
  writeFileSync(today, `${all.slice(0, 7).join("\n")}\n{ torn\n`);
  assert.equal(verify().ok, false);

  assert.equal(run(["recover"]).status, 0);
  assert.equal(seals()[1], `ack ${day} 7`);
  const result = verify();
  assert.equal(result.ok, true, JSON.stringify(result.seal));
  assert.match(result.seal.warnings[0].message, /was recovered at .*, keeping 7 event\(s\)/);
});

test("a seal is of one log directory; a log kept elsewhere never touches it", (t) => {
  const elsewhere = sandbox(t, { sealOf: "/somewhere/else/logs" });
  elsewhere.add(12);
  assert.deepEqual(elsewhere.seals(), []);
  assert.equal(elsewhere.verify().seal, undefined);
  assert.match(elsewhere.run(["seal", "status"]).stdout, /sealed mode is off for this log: .* is the seal of a different log directory/);
  assert.equal(elsewhere.run(["purge", localDay()]).status, 0);
  assert.deepEqual(elsewhere.seals(), []);

  const off = sandbox(t, { sealed: false });
  off.add(12);
  assert.equal(off.verify().seal, undefined);
  assert.match(off.run(["seal", "status"]).stdout, /^sealed mode is off \(see: eventloom seal enable\)/);
  assert.match(off.run(["seal", "enable"]).stdout, /read .*seal\/setup\.sh and then run:\n {2}sudo sh .*seal\/setup\.sh$/m);
  assert.match(off.run(["seal", "now"]).stderr, /sealed mode is off/);
  assert.match(off.run(["doctor"]).stdout, /ok +sealed mode +off/);
});

test("a helper that cannot be run loses no events, and doctor says so", (t) => {
  const { run, lines, helper, seals } = sandbox(t);
  writeFileSync(helper, "#!/bin/sh\necho 'eventloom-seal: broken' >&2\nexit 1\n");
  for (let i = 0; i < 10; i++) assert.equal(run(["append", "agent.note.added", "--actor", "t"]).status, 0);
  assert.equal(lines().length, 11, "the anchor and all ten events are in the log");
  assert.deepEqual(seals(), []);
  const doctor = run(["doctor"]);
  assert.match(doctor.stdout, /fail +sealed mode +on, but the helper cannot be run/);
  assert.match(doctor.stdout, /warn +recent errors .*latest from seal: could not seal the log: eventloom-seal: broken/);
  assert.match(run(["purge", localDay()]).stderr, /could not record this in the seal file/);
  assert.equal(lines().length, 11, "a purge that cannot be recorded does not happen");
});

test("seal now seals what is there, and status reports it", (t) => {
  const { add, run, seals } = sandbox(t);
  const day = localDay();
  add(3);
  assert.equal(run(["seal", "now"]).stdout, `sealed ${day} at event 4\n`);
  assert.deepEqual(seals(), [`head ${day} 4`]);
  const status = run(["seal", "status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /^sealed mode is on: .*\n {2}1 record\(s\), last at \d{4}-.*Z; 0 event\(s\) not yet sealed\n$/);
  assert.match(run(["seal", "enable"]).stdout, /sealed mode is already on/);
  assert.match(run(["seal", "sideways"]).stderr, /usage: eventloom seal/);
});
