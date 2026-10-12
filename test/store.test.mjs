import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readErrors, recordError } from "../lib/error-log.mjs";
import { errorLogPath, localDay, shardPath } from "../lib/paths.mjs";
import { STALE_LOCK_MS, appendEvents, breakStaleLock, purgeShard, readRecentEvents, readShard, recoverShards, verifyShards } from "../lib/store.mjs";
import { SHARD_ANCHOR_TYPE } from "../lib/vocabulary.mjs";
import { note, useTempLogDir } from "./helpers.mjs";

const shard = (dir, day) => path.join(dir, `${day}.jsonl`);

test("a new shard is private and opens with an anchor to the previous one", async (t) => {
  const dir = useTempLogDir(t);
  const [first] = await appendEvents([note("day one")], shard(dir, "2026-01-01"));
  await appendEvents([note("day two")], shard(dir, "2026-01-02"));

  assert.equal(statSync(shard(dir, "2026-01-01")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const [anchor, event] = readShard(shard(dir, "2026-01-02")).events;
  assert.equal(anchor.type, SHARD_ANCHOR_TYPE);
  assert.deepEqual(anchor.payload, {
    previous_shard: "2026-01-01.jsonl",
    previous_hash: first.integrity.hash,
    previous_event_count: 2,
  });
  assert.equal(event.payload.text, "day two");
  assert.equal((await verifyShards()).ok, true);
});

test("verify notices a shortened or deleted earlier shard", async (t) => {
  const dir = useTempLogDir(t);
  await appendEvents([note("a"), note("b")], shard(dir, "2026-01-01"));
  await appendEvents([note("c")], shard(dir, "2026-01-02"));
  await appendEvents([note("d")], shard(dir, "2026-01-03"));

  const dayOne = readFileSync(shard(dir, "2026-01-01"), "utf8").trimEnd().split("\n");
  writeFileSync(shard(dir, "2026-01-01"), `${dayOne.slice(0, -1).join("\n")}\n`);
  const shortened = await verifyShards();
  assert.equal(shortened.ok, false);
  assert.equal(shortened.reports[1].errors[0].code, "anchor_mismatch");

  unlinkSync(shard(dir, "2026-01-02"));
  const deleted = await verifyShards();
  assert.match(deleted.reports.at(-1).errors[0].message, /names 2026-01-02\.jsonl, which is missing/);
});

test("a late append to yesterday's shard does not break today's anchor", async (t) => {
  const dir = useTempLogDir(t);
  await appendEvents([note("a")], shard(dir, "2026-01-01"));
  // a writer that picked yesterday's shard just before midnight lands after today's first event
  await Promise.all([
    appendEvents([note("today")], shard(dir, "2026-01-02")),
    appendEvents([note("late")], shard(dir, "2026-01-01")),
  ]);
  await appendEvents([note("later still")], shard(dir, "2026-01-01"));
  assert.equal((await verifyShards()).ok, true);
});

test("a shard path spelled differently is anchored to the same previous shard", async (t) => {
  const dir = useTempLogDir(t);
  await appendEvents([note("a")], shard(dir, "2026-01-01"));
  await appendEvents([note("b")], path.join(dir, "..", "logs", ".", "2026-01-03.jsonl"));
  assert.equal(readShard(shard(dir, "2026-01-03")).events[0].payload.previous_shard, "2026-01-01.jsonl");
  assert.equal((await verifyShards()).ok, true);
});

test("shards written before anchoring verify with a warning, not an error", async (t) => {
  const dir = useTempLogDir(t);
  await appendEvents([note("a")], shard(dir, "2026-01-01"));
  await appendEvents([note("b")], shard(dir, "2026-01-02"));
  // rebuild day two without its anchor, as an older release would have written it
  unlinkSync(shard(dir, "2026-01-02"));
  const outside = path.join(dir, "..", "legacy.jsonl");
  await appendEvents([note("b")], outside);
  writeFileSync(shard(dir, "2026-01-02"), readFileSync(outside, "utf8"));

  const result = await verifyShards();
  assert.equal(result.ok, true);
  assert.equal(result.reports[1].warnings[0].code, "unanchored_shard");
});

test("an orphaned lock is removed and recorded; a fresh one is respected", async (t) => {
  const dir = useTempLogDir(t);
  const log = shard(dir, "2026-01-01");
  await appendEvents([note("before")], log);

  writeFileSync(`${log}.lock`, "");
  assert.equal(breakStaleLock(log), false, "a lock younger than the threshold may have a live owner");

  const old = (Date.now() - STALE_LOCK_MS - 1000) / 1000;
  utimesSync(`${log}.lock`, old, old);
  await appendEvents([note("after")], log);
  assert.equal(existsSync(`${log}.lock`), false);
  assert.equal(readShard(log).events.at(-1).payload.text, "after");
  assert.match(readErrors().at(-1).message, /removed orphaned lock/);
});

test("concurrent writers all land and the chain stays valid", async (t) => {
  const dir = useTempLogDir(t);
  const log = shard(dir, "2026-01-01");
  await Promise.all(Array.from({ length: 25 }, (_, index) => appendEvents([note(`n${index}`)], log)));
  const { events } = readShard(log);
  assert.equal(events.filter((event) => event.type === "agent.note.added").length, 25);
  assert.equal((await verifyShards()).ok, true);
});

test("a damaged line blocks appends until recover sets it aside", async (t) => {
  const dir = useTempLogDir(t);
  const log = shard(dir, "2026-01-01");
  await appendEvents([note("kept")], log);
  appendFileSync(log, '{"torn":\n');

  assert.deepEqual(readShard(log).malformedLines, [3]);
  await assert.rejects(appendEvents([note("refused")], log), /corrupt event log/);

  const { recovered: [result] } = await recoverShards([log]);
  assert.equal(result.keptEvents, 2);
  assert.match(readFileSync(result.setAsidePath, "utf8"), /"torn"/);
  await appendEvents([note("accepted")], log);
  assert.equal((await verifyShards()).ok, true);
  assert.deepEqual(await recoverShards([log]), { recovered: [], failed: [] });
});

test("recover clears an orphaned lock on a shard nothing appends to any more", async (t) => {
  const dir = useTempLogDir(t);
  const past = shard(dir, "2026-01-01");
  await appendEvents([note("kept")], past);
  appendFileSync(past, '{"torn":\n');
  writeFileSync(`${past}.lock`, "");
  const old = (Date.now() - STALE_LOCK_MS - 1000) / 1000;
  utimesSync(`${past}.lock`, old, old);

  assert.equal((await recoverShards([past])).recovered.length, 1);
  assert.equal(existsSync(`${past}.lock`), false);
  assert.equal((await verifyShards()).ok, true);
});

// Three days, each anchored to the one before, plus helpers to damage them.
async function threeDays(dir) {
  await appendEvents([note("a"), note("b")], shard(dir, "2026-01-01"));
  await appendEvents([note("c")], shard(dir, "2026-01-02"));
  await appendEvents([note("d")], shard(dir, "2026-01-03"));
}
function tearAfter(file, keptLines) {
  const lines = readFileSync(file, "utf8").split("\n").slice(0, keptLines);
  writeFileSync(file, `${lines.join("\n")}\n{"torn":\n`);
}
const warningsFor = (result, day) => result.reports.find((report) => report.path.endsWith(`${day}.jsonl`)).warnings;

test("recovering an earlier shard leaves an acknowledged gap, not a failure", async (t) => {
  const dir = useTempLogDir(t);
  await threeDays(dir);
  tearAfter(shard(dir, "2026-01-01"), 2); // day two is anchored past this point
  assert.equal((await verifyShards()).ok, false);

  await recoverShards();
  const result = await verifyShards();
  assert.equal(result.ok, true);
  assert.equal(warningsFor(result, "2026-01-02")[0].code, "acknowledged_gap");
});

test("cutting a recovered shard below the prefix that was kept is an error again", async (t) => {
  const dir = useTempLogDir(t);
  await threeDays(dir);
  tearAfter(shard(dir, "2026-01-01"), 2);
  await recoverShards();
  assert.equal((await verifyShards()).ok, true);

  const [anchorOnly] = readFileSync(shard(dir, "2026-01-01"), "utf8").split("\n");
  writeFileSync(shard(dir, "2026-01-01"), `${anchorOnly}\n`);
  assert.equal((await verifyShards()).ok, false);
});

test("an acknowledgement does not cover damage done after it", async (t) => {
  const dir = useTempLogDir(t);
  await appendEvents([note("a")], shard(dir, "2026-01-01"));
  appendFileSync(shard(dir, "2026-01-01"), '{"torn":\n');
  await recoverShards(); // keeps 2 events and records it

  // the shard goes on being written, and the next day is anchored at 4
  await appendEvents([note("b"), note("c")], shard(dir, "2026-01-01"));
  await appendEvents([note("next day")], shard(dir, "2026-01-02"));
  assert.equal((await verifyShards()).ok, true);

  // back to exactly the recovered prefix: the two later events are gone
  const lines = readFileSync(shard(dir, "2026-01-01"), "utf8").split("\n");
  writeFileSync(shard(dir, "2026-01-01"), `${lines.slice(0, 2).join("\n")}\n`);
  const result = await verifyShards();
  assert.equal(result.ok, false);
  assert.equal(warningsFor(result, "2026-01-02").length, 0);
});

test("a recovery that cannot be recorded leaves the shard alone, so a later run can finish it", async (t) => {
  const dir = useTempLogDir(t);
  await threeDays(dir);
  await appendEvents([note("today")]);
  tearAfter(shard(dir, "2026-01-01"), 2);
  writeFileSync(`${shardPath()}.lock`, ""); // today's shard is busy: the record cannot be written

  const blocked = await recoverShards([shard(dir, "2026-01-01")]);
  assert.match(blocked.failed[0].message, /Timed out waiting for event log lock/);
  assert.match(readFileSync(shard(dir, "2026-01-01"), "utf8"), /"torn"/, "not cut back without its record");

  unlinkSync(`${shardPath()}.lock`);
  assert.equal((await recoverShards()).recovered.length, 1);
  assert.equal((await verifyShards()).ok, true);
});

test("a recovered shard swapped for a different chain of the same length is not excused", async (t) => {
  const dir = useTempLogDir(t);
  await threeDays(dir);
  tearAfter(shard(dir, "2026-01-01"), 2);
  await recoverShards();
  assert.equal((await verifyShards()).ok, true);

  const elsewhere = path.join(dir, "..", "forged.jsonl");
  await appendEvents([note("forged"), note("forged too")], elsewhere);
  writeFileSync(shard(dir, "2026-01-01"), readFileSync(elsewhere, "utf8"));
  assert.equal((await verifyShards()).ok, false);
});

test("an older acknowledgement carried forward does not undo a newer one", async (t) => {
  const dir = useTempLogDir(t);
  await threeDays(dir);
  tearAfter(shard(dir, "2026-01-01"), 2);
  await recoverShards(); // "recovered" record for day one, held in today's shard
  const today = localDay();
  await appendEvents([note("x")], shard(dir, "2099-01-01")); // a later shard to hold the next record
  renameSync(shard(dir, "2099-01-01"), shard(dir, "2026-01-04"));
  await purgeShard("2026-01-01"); // "purged" record for day one, also in today's shard
  await purgeShard(today); // both are carried into a fresh shard for today
  const result = await verifyShards();
  assert.deepEqual(result.reports.flatMap((report) => report.errors).filter((error) => /2026-01-01/.test(error.message)), []);
});

test("purging today before anything was ever logged is not an error", async (t) => {
  useTempLogDir(t);
  assert.deepEqual(await purgeShard(localDay()), { deleted: false });
});

test("recover works when today's shard is damaged as well as an earlier one", async (t) => {
  const dir = useTempLogDir(t);
  await threeDays(dir);
  await appendEvents([note("today")]);
  tearAfter(shard(dir, "2026-01-01"), 2);
  appendFileSync(shardPath(), '{"torn":\n');

  const { recovered, failed } = await recoverShards();
  assert.equal(recovered.length, 2);
  assert.deepEqual(failed, []);
  assert.equal((await verifyShards()).ok, true);
});

test("purging a day removes it and its set-aside copies, and is acknowledged", async (t) => {
  const dir = useTempLogDir(t);
  await threeDays(dir);
  tearAfter(shard(dir, "2026-01-02"), 2);
  await recoverShards();
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("2026-01-02.jsonl")).length, 2);

  assert.deepEqual(await purgeShard("2026-01-02"), { deleted: true });
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("2026-01-02.jsonl")), []);
  const result = await verifyShards();
  assert.equal(result.ok, true);
  assert.match(warningsFor(result, "2026-01-03")[0].message, /2026-01-02\.jsonl, which is missing/);
});

test("purging an earlier day before today's shard exists is still acknowledged", async (t) => {
  // The purge itself opens today's shard, whose anchor names the day being
  // purged. Repeated because the failure this guards against depended on
  // whether two timestamps fell in the same millisecond.
  for (let attempt = 0; attempt < 15; attempt++) {
    const dir = useTempLogDir(t);
    await appendEvents([note("a"), note("b"), note("c")], shard(dir, "2026-01-01"));
    await purgeShard("2026-01-01");
    const result = await verifyShards();
    assert.equal(result.ok, true, JSON.stringify(result.reports.flatMap((report) => report.errors)));
  }
});

test("purging the shard that holds an acknowledgement carries it forward", async (t) => {
  const dir = useTempLogDir(t);
  await threeDays(dir);
  await purgeShard("2026-01-01"); // acknowledged in today's shard
  await purgeShard(localDay()); // which is now purged in turn
  assert.equal((await verifyShards()).ok, true);
});

test("a day deleted by hand can be acknowledged afterwards; a shard being written cannot be purged", async (t) => {
  const dir = useTempLogDir(t);
  await threeDays(dir);
  unlinkSync(shard(dir, "2026-01-02"));
  assert.equal((await verifyShards()).ok, false);
  assert.deepEqual(await purgeShard("2026-01-02"), { deleted: false });
  assert.equal((await verifyShards()).ok, true);

  writeFileSync(`${shard(dir, "2026-01-03")}.lock`, "");
  await assert.rejects(purgeShard("2026-01-03"), /is being written to/);
  assert.equal(existsSync(shard(dir, "2026-01-03")), true);
});

test("a gap nobody acknowledged is still an error", async (t) => {
  const dir = useTempLogDir(t);
  await appendEvents([note("a")], shard(dir, "2026-01-01"));
  await appendEvents([note("b")], shard(dir, "2026-01-02"));
  unlinkSync(shard(dir, "2026-01-01"));
  assert.equal((await verifyShards()).ok, false);
});

test("recent events are read back across shards, newest shard first", async (t) => {
  const dir = useTempLogDir(t);
  await appendEvents([note("1"), note("2", "other")], shard(dir, "2026-01-01"));
  await appendEvents([note("3")], shard(dir, "2026-01-02"));
  const isNote = (event) => event.type === "agent.note.added";

  assert.deepEqual(readRecentEvents(2, isNote).events.map((event) => event.payload.text), ["2", "3"]);
  assert.deepEqual(readRecentEvents(5, (event) => isNote(event) && event.actorId === "tester").events.map((event) => event.payload.text), ["1", "3"]);
  assert.deepEqual(readRecentEvents(0).events, []);
});

test("the error log is cut back once it passes its size limit", (t) => {
  useTempLogDir(t);
  for (let entry = 0; entry < 400; entry++) recordError("test", `${entry} ${"x".repeat(2000)}`);
  assert.ok(statSync(errorLogPath()).size < 256 * 1024 + 2000);
  assert.match(readErrors().at(-1).message, /^399 /);
});
