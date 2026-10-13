// The daily shards: one hash-chained JSONL file per local day, written
// through @eventloom/runtime. This module adds what a set of shards needs and
// a single log file does not: orphaned-lock recovery, a link from each shard
// to the one before it, and reads that survive a damaged line.
import { JsonlEventStore, createEvent } from "@eventloom/runtime";
import { chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { recordError } from "./error-log.mjs";
import { isShardPath, listShardPaths, logDir, shardPath } from "./paths.mjs";
import { SHARD_ACK_TYPE, SHARD_ANCHOR_TYPE } from "./vocabulary.mjs";

// The runtime holds `<shard>.lock` only while it scans and appends (about a
// second at 100,000 events), and it has no way to tell that a lock's owner
// has died. A writer killed inside that window would otherwise block every
// later append to the shard. A lock this old is taken to have no live owner.
//
// Known limit: that is an inference, not proof. A writer suspended for longer
// than this, or one that takes the lock in the instant between the checks
// below, can end up appending alongside another. The runtime then refuses
// further appends to the shard and `eventloom recover` repairs it.
export const STALE_LOCK_MS = 30_000;

// Claims the stale lock by renaming it, so of two processes that both saw it
// only one removes it. If a new writer took the lock between the look and
// the rename, the claimed file is that writer's and is put back.
export function breakStaleLock(logPath, now = Date.now()) {
  const lockPath = `${logPath}.lock`;
  const seen = statSync(lockPath, { throwIfNoEntry: false });
  if (!seen || now - seen.mtimeMs < STALE_LOCK_MS) return false;
  const claimed = `${lockPath}.stale-${process.pid}`;
  try {
    renameSync(lockPath, claimed);
  } catch (err) {
    if (err.code === "ENOENT") return false; // another process claimed it first
    throw err;
  }
  const taken = statSync(claimed);
  const wasStale = taken.ino === seen.ino && taken.mtimeMs === seen.mtimeMs;
  if (!wasStale) {
    try {
      linkSync(claimed, lockPath);
    } catch (err) {
      if (err.code !== "EEXIST") throw err; // a third writer already holds a fresh lock
    }
  }
  rmSync(claimed, { force: true });
  return wasStale;
}

function fileSize(file) {
  return statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

function envelope({ type, actorId, threadId, payload }) {
  return createEvent({ type, actorId, threadId, parentEventId: null, causedBy: [], payload });
}

// A new shard opens with a record of where the previous shard stood at that
// moment (writers racing to open the same shard may each add one). Each
// shard's own chain starts from nothing, so without this link a deleted or
// shortened earlier day would still verify. A writer that started before
// midnight may still append to the previous shard afterwards; the anchor
// pins everything up to its count, not the shard's final length.
async function anchorFor(logPath) {
  const name = path.basename(logPath);
  const earlier = listShardPaths().filter((shard) => path.basename(shard) < name);
  const previous = earlier.at(-1);
  const report = previous ? await new JsonlEventStore(previous).verify() : null;
  return envelope({
    type: SHARD_ANCHOR_TYPE,
    actorId: "eventloom",
    threadId: "eventloom-chain",
    payload: {
      previous_shard: previous ? path.basename(previous) : null,
      previous_hash: report?.lastGoodHash ?? null,
      previous_event_count: report?.validPrefixCount ?? 0,
    },
  });
}

// Seal and append events to one shard under a single lock. Each draft is
// { type, actorId, threadId, payload } with the payload already redacted.
export async function appendEvents(drafts, requestedPath = shardPath()) {
  const logPath = path.resolve(requestedPath);
  const managed = isShardPath(logPath);
  if (managed) mkdirSync(logDir(), { recursive: true, mode: 0o700 });
  if (breakStaleLock(logPath)) recordError("store", `removed orphaned lock ${logPath}.lock`);

  const startsShard = fileSize(logPath) === 0;
  const events = drafts.map(envelope);
  if (managed && startsShard) events.unshift(await anchorFor(logPath));

  const sealed = await new JsonlEventStore(logPath).appendMany(events);
  // The log holds tool and approval history; keep it private whatever the umask.
  if (startsShard) chmodSync(logPath, 0o600);
  return managed && startsShard ? sealed.slice(1) : sealed;
}

// One line of a shard as an event, or null if it is damaged.
function parseLine(line) {
  try {
    const event = JSON.parse(line);
    return event && typeof event === "object" && typeof event.type === "string" ? event : null;
  } catch {
    return null; // a torn or hand-edited line; `verify` reports it
  }
}

// Parse a shard without trusting it: damaged lines are counted, not thrown.
export function readShard(logPath) {
  const events = [];
  const malformedLines = [];
  for (const [index, line] of readFileSync(logPath, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const event = parseLine(line);
    if (event) events.push(event);
    else malformedLines.push(index + 1);
  }
  return { events, malformedLines };
}

// The oldest event matching `keep`, or null. Shards are walked oldest first.
// Only lines that contain `containing` are parsed, which keeps a search for
// one rare event type cheap however long the log has grown.
export function findFirstEvent(keep, containing = "", shards = listShardPaths()) {
  for (const shard of shards) {
    for (const line of readFileSync(shard, "utf8").split("\n")) {
      if (!line.includes(containing)) continue;
      const event = parseLine(line);
      if (event && keep(event)) return event;
    }
  }
  return null;
}

// The newest `limit` events matching `keep`, oldest first. Shards are walked
// newest first and each from its last line back, so only as many lines are
// parsed as it takes to find them.
export function readRecentEvents(limit, keep = () => true, shards = listShardPaths()) {
  const newestFirst = [];
  const malformed = [];
  for (const shard of [...shards].reverse()) {
    const lines = readFileSync(shard, "utf8").split("\n");
    for (let index = lines.length - 1; index >= 0 && newestFirst.length < limit; index--) {
      if (!lines[index].trim()) continue;
      const event = parseLine(lines[index]);
      if (!event) malformed.push({ shard, line: index + 1 });
      else if (keep(event)) newestFirst.push(event);
    }
    if (newestFirst.length >= limit) break;
  }
  return { events: newestFirst.reverse(), malformed };
}

const UNANCHORED = {
  code: "unanchored_shard",
  message: "written before shard anchoring; not linked to an earlier shard",
};

// An anchor holds if the shard it names still exists and its event number
// `previous_event_count` still has the recorded hash.
function anchorProblem(anchor, hashesByShard) {
  const { previous_shard: name, previous_hash: hash, previous_event_count: count } = anchor.payload ?? {};
  if (name === null && hash === null && count === 0) return null;
  if (typeof name !== "string" || !Number.isInteger(count) || count < 0) return "is malformed";
  const hashes = hashesByShard.get(name);
  if (!hashes) return `names ${name}, which is missing`;
  const found = count === 0 ? null : hashes[count - 1] ?? "(no such event)";
  if (found !== hash) return `expects event ${count} of ${name} to have hash ${hash}, found ${found}`;
  return null;
}

// `recover` and `purge` record what they did, and when. An anchor's problem
// counts as acknowledged only if the anchor was sealed before that record,
// and the shard is still in the state the record describes: gone if it was
// purged, or still holding the kept prefix if it was recovered. Damage done
// after the record is not covered by it.
function isAcknowledged(anchor, acknowledgements, hashesByShard) {
  const name = anchor.payload?.previous_shard;
  const hashes = hashesByShard.get(name);
  return (acknowledgements.get(name) ?? []).some((ack) => {
    if (typeof ack.acknowledged_at !== "string" || anchor.timestamp > ack.acknowledged_at) return false;
    if (ack.action === "purged") return hashes === undefined;
    if (hashes === undefined || !Number.isInteger(ack.kept_events)) return false;
    return ack.kept_events === 0 || (typeof ack.kept_hash === "string" && hashes[ack.kept_events - 1] === ack.kept_hash);
  });
}

// Verify each shard's own chain, then the anchors that link the shards.
// `shards` must be the complete, ordered set for the anchor check to mean
// anything; a single file passed alone is checked for its own chain only.
// Each shard is read once, and only its hashes, anchors and acknowledgements
// are kept while the others are read.
export async function verifyShards(shards = listShardPaths(), { checkLinks = true } = {}) {
  const scanned = [];
  const hashesByShard = new Map();
  const acknowledgements = new Map();
  for (const shard of shards) {
    const { report, validEvents } = await new JsonlEventStore(shard).readVerifiedSnapshot();
    hashesByShard.set(path.basename(shard), validEvents.map((event) => event.integrity.hash));
    for (const event of validEvents) {
      if (event.type !== SHARD_ACK_TYPE) continue;
      if (!acknowledgements.has(event.payload.shard)) acknowledgements.set(event.payload.shard, []);
      acknowledgements.get(event.payload.shard).push(event.payload);
    }
    scanned.push({ shard, report, anchors: validEvents.filter((event) => event.type === SHARD_ANCHOR_TYPE) });
  }

  const reports = scanned.map(({ shard, report, anchors }, index) => {
    const errors = [...report.errors];
    const warnings = [];
    if (checkLinks && !anchors.length && index > 0) warnings.push(UNANCHORED);
    for (const anchor of checkLinks ? anchors : []) {
      const problem = anchorProblem(anchor, hashesByShard);
      if (!problem) continue;
      const finding = { eventId: anchor.id, message: `shard anchor ${problem}` };
      if (isAcknowledged(anchor, acknowledgements, hashesByShard)) {
        warnings.push({ code: "acknowledged_gap", ...finding });
      } else {
        errors.push({ code: "anchor_mismatch", ...finding });
      }
    }
    return { path: shard, ok: errors.length === 0, events: report.eventCount, errors, warnings };
  });
  return { ok: reports.every((report) => report.ok), reports };
}

// Today's shard has to exist before a record is stamped for it. Opening it
// writes its anchor, which may name the very shard the record is about, and
// a record only covers anchors that are older than itself.
const openTodaysShard = () => appendEvents([]);

// `acknowledged_at` travels in the payload so that it survives the record
// being carried into another shard, which would give it a new timestamp.
function acknowledgement(payload) {
  return {
    type: SHARD_ACK_TYPE,
    actorId: "eventloom",
    threadId: "eventloom-chain",
    payload: { acknowledged_at: new Date().toISOString(), ...payload },
  };
}

const isTodaysShard = (logPath) => path.resolve(logPath) === path.resolve(shardPath());

function lockIsFresh(logPath) {
  const lock = statSync(`${logPath}.lock`, { throwIfNoEntry: false });
  return lock !== undefined && Date.now() - lock.mtimeMs < STALE_LOCK_MS;
}

// A damaged line makes the runtime refuse every further append to that shard.
// Keep the verified prefix as the shard and set the original aside untouched.
// The original is hard-linked aside and the prefix renamed over it, so the
// shard never stops existing and a concurrent append cannot start a new one.
//
// A later shard may be anchored past the prefix that is kept, so the cut is
// acknowledged in today's shard, and before it is made: if that record cannot
// be written the shard is left as it was, to be recovered on a later run.
// Today's own shard cannot hold a record until it is sound, so its comes after.
// Returns null when the shard needed nothing.
async function recoverShard(logPath) {
  if (breakStaleLock(logPath)) recordError("store", `removed orphaned lock ${logPath}.lock`);
  const store = new JsonlEventStore(logPath);
  const report = await store.verify();
  if (report.ok) return null;
  const record = () => acknowledgement({
    shard: path.basename(logPath),
    action: "recovered",
    kept_events: report.validPrefixCount,
    kept_hash: report.lastGoodHash,
  });
  const recordFirst = isShardPath(logPath) && !isTodaysShard(logPath);
  if (recordFirst) {
    await openTodaysShard();
    await appendEvents([record()]);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefixPath = `${logPath}.recovered-${stamp}`;
  const setAsidePath = `${logPath}.corrupt-${stamp}`;
  await store.recoverVerifiedPrefix(prefixPath);
  linkSync(logPath, setAsidePath);
  chmodSync(prefixPath, 0o600);
  renameSync(prefixPath, logPath);
  if (isShardPath(logPath) && !recordFirst) await appendEvents([record()]);
  return { shard: logPath, keptEvents: report.validPrefixCount, setAsidePath };
}

// Recover every damaged shard given, newest first so that today's shard is
// sound before earlier ones need it. One shard that cannot be recovered does
// not stop the others.
export async function recoverShards(shards = listShardPaths()) {
  const recovered = [];
  const failed = [];
  for (const shard of [...shards].reverse()) {
    try {
      const result = await recoverShard(shard);
      if (result) recovered.push(result);
    } catch (err) {
      failed.push({ shard, message: err.message });
    }
  }
  return { recovered, failed };
}

// Delete one day's shard, with the copies `recover` set aside, and say so in
// the log, so the gap is a recorded decision and not something `verify` has
// to call tampering. Acknowledgements the shard itself held are carried over.
// A day that is already gone can be purged again to record it.
export async function purgeShard(day) {
  const name = `${day}.jsonl`;
  const logPath = path.join(logDir(), name);
  const refuseIfBeingWritten = () => {
    if (lockIsFresh(logPath)) throw new Error(`${name} is being written to; try again shortly`);
  };
  refuseIfBeingWritten();

  const existed = statSync(logPath, { throwIfNoEntry: false }) !== undefined;
  const carried = existed ? readShard(logPath).events.filter((event) => event.type === SHARD_ACK_TYPE) : [];
  const records = () => [
    ...carried.map((event) => acknowledgement(event.payload)),
    acknowledgement({ shard: name, action: "purged" }),
  ];
  const removeFiles = () => {
    refuseIfBeingWritten(); // a writer may have arrived while the record was appended
    if (!statSync(logDir(), { throwIfNoEntry: false })) return;
    for (const file of readdirSync(logDir())) {
      if (file === name || file.startsWith(`${name}.`)) rmSync(path.join(logDir(), file), { force: true });
    }
  };

  // Record first, so a failure leaves the day in place and not silently gone.
  // Today's shard is the one case where the record can only follow.
  if (isTodaysShard(logPath)) {
    removeFiles();
    await appendEvents(records());
  } else {
    await openTodaysShard();
    await appendEvents(records());
    removeFiles();
  }
  return { deleted: existed };
}
