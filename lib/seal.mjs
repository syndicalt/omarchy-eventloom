// Sealed mode: a record, outside the log and outside its owner's reach, of
// how far the log had got. See docs/sealed-mode.md.
//
// The seal file belongs to another user. This module can read it and can ask
// the helper, through sudo, to append to it; it cannot write it. A log is
// sealed if that file exists and names the log's directory: there is no
// setting to turn, because an agent could turn it back. A log kept anywhere
// else (a test's, a sandbox's) is not this seal's business and never touches
// it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { listShardPaths, logDir } from "./paths.mjs";

export const SEAL_USER = "eventloom-seal";
export const SEAL_HELPER = "/usr/local/libexec/eventloom-seal";
// The newest record format this code reads and the helper it expects.
export const SEAL_FORMAT = 1;
// At most this many events are written between seals.
export const SEAL_EVERY = 10;
const BOUNDARIES = new Set([
  "agent.session.started", "agent.session.resumed", "agent.session.completed", "agent.session.failed",
]);
const HELPER_TIMEOUT_MS = 5000;
const MOVED_ON = 4; // the helper's exit when the log already stands further on

// EVENTLOOM_SEAL_DIR and EVENTLOOM_SEAL_HELPER exist for tests and
// sandboxes, which have no second user: the helper is then run directly.
export function sealFile(env = process.env) {
  return path.join(env.EVENTLOOM_SEAL_DIR || "/var/lib/eventloom-seal", `${process.getuid()}.evtseal`);
}

function helperCommand(env = process.env) {
  return env.EVENTLOOM_SEAL_HELPER ? [env.EVENTLOOM_SEAL_HELPER] : ["sudo", "-n", "-u", SEAL_USER, SEAL_HELPER];
}

const HEADER = /^eventloom-seal (\d+) uid=\d+ log=(.+)$/;

// The log directory a seal file was made for, or null if it does not say.
function sealedLogDir(file) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const header = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0)).split("\n")[0];
    return HEADER.exec(header)?.[2] ?? null;
  } finally {
    closeSync(fd);
  }
}

// "on": this log is sealed. "other": a seal file exists, for a different log
// directory. "off": there is none.
export function sealState() {
  const file = sealFile();
  if (!existsSync(file)) return "off";
  return sealedLogDir(file) === path.resolve(logDir()) ? "on" : "other";
}

export function isSealed() {
  return sealState() === "on";
}

function askHelper(args) {
  const [command, ...prefix] = helperCommand();
  return execFileSync(command, [...prefix, ...args], {
    encoding: "utf8", timeout: HELPER_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function helperFailure(err) {
  const said = String(err.stderr ?? "").trim().split("\n").at(-1);
  return said || err.message;
}

// The helper's format version, or null if it cannot be run.
export function helperVersion() {
  try {
    return Number(askHelper(["version"]));
  } catch {
    return null;
  }
}

function parseRecord(line) {
  const [sequence, time, kind, day, position, value, link] = line.split(" ");
  return { sequence: Number(sequence), time, kind, day, position: Number(position), value, link, line };
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// The whole seal file, with its own chain checked.
export function readSealFile(file = sealFile()) {
  const [header, ...lines] = readFileSync(file, "utf8").trimEnd().split("\n");
  const errors = [];
  const format = HEADER.exec(header)?.[1];
  if (format === undefined) errors.push("its first line is not a seal file header");
  else if (Number(format) > SEAL_FORMAT) errors.push(`it is format ${format}; this eventloom reads up to ${SEAL_FORMAT}`);
  const records = lines.map(parseRecord);
  let link = sha256(`${header}\n`);
  for (const [index, record] of records.entries()) {
    const body = record.line.slice(0, record.line.lastIndexOf(" "));
    link = sha256(`${link} ${body}\n`);
    if (record.sequence !== index + 1 || record.link !== `sha256:${link}`) {
      errors.push(`record ${index + 1} does not follow from the one before it`);
      break;
    }
  }
  return { records, errors };
}

// Where the log last stood according to `records`: the newest head, cut back
// by any later ack for the same day. The helper applies the same rule.
function standing(records) {
  const acked = new Map();
  for (const record of [...records].reverse()) {
    if (record.kind === "ack" && !acked.has(record.day)) acked.set(record.day, record.position);
    if (record.kind === "head") return { day: record.day, position: acked.get(record.day) ?? record.position };
  }
  return null;
}

// The last few records, without reading a file that only ever grows.
function recentRecords(file, bytes = 16 * 1024) {
  const fd = openSync(file, "r");
  try {
    const { size } = fstatSync(fd);
    const buffer = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.toString("utf8").trimEnd().split("\n");
    // the first line may be cut in half, or be the header
    return lines.slice(1).map(parseRecord);
  } finally {
    closeSync(fd);
  }
}

// The count and last hash of a shard as it is on disk now, or null if its
// last line is not a whole event (another writer is in the middle of one).
function shardHead(shard) {
  const lines = readFileSync(shard, "utf8").split("\n").filter((line) => line.trim());
  try {
    const hash = JSON.parse(lines.at(-1)).integrity.hash;
    return typeof hash === "string" ? { day: path.basename(shard, ".jsonl"), position: lines.length, hash } : null;
  } catch {
    return null;
  }
}

function sealHead(head) {
  try {
    askHelper(["head", head.day, String(head.position), head.hash]);
  } catch (err) {
    // another writer sealed past this point first: nothing was lost
    if (err.status !== MOVED_ON) throw new Error(`could not seal the log: ${helperFailure(err)}`, { cause: err });
  }
}

// Seal a shard's head now, whatever the count since the last seal.
export function sealShard(shard) {
  const head = shardHead(shard);
  if (head) sealHead(head);
  return head;
}

// Called after events are appended to `shard`. Seals when a session opened or
// closed, or when SEAL_EVERY events have gone by. When the day has turned,
// the previous shard's last events are sealed first: once today has a head,
// an earlier day can no longer be given one.
export function sealIfDue(shard, appended) {
  if (!appended.length || !isSealed()) return;
  const head = shardHead(shard);
  if (!head) return;
  const last = standing(recentRecords(sealFile()));
  if (last && last.day > head.day) return;
  const sinceLast = head.position - (last?.day === head.day ? last.position : 0);
  if (sinceLast < SEAL_EVERY && !appended.some((event) => BOUNDARIES.has(event.type))) return;
  if (!last || last.day < head.day) {
    const earlier = listShardPaths().filter((other) => path.basename(other, ".jsonl") < head.day).at(-1);
    if (earlier) sealShard(earlier);
  }
  sealHead(head);
}

// Records in the seal file that a shard was purged or cut back to `kept`
// events on purpose. Throws if sealed mode is on and the record cannot be made.
export function sealAcknowledgement(day, kept, what) {
  if (!isSealed()) return;
  try {
    askHelper(["ack", day, String(kept), what]);
  } catch (err) {
    throw new Error(`could not record this in the seal file: ${helperFailure(err)}`, { cause: err });
  }
}

// Compares the seal file with the log. `hashesByShard` maps a shard's file
// name to the hashes of its verified events, in order.
export function verifySeal(hashesByShard) {
  const file = sealFile();
  const { records, errors: fileErrors } = readSealFile(file);
  const errors = fileErrors.map((message) => ({ code: "seal_file_damaged", message: `the seal file is damaged: ${message}` }));
  const warnings = [];
  const headsByDay = new Map();
  for (const record of records) {
    if (record.kind === "head") {
      if (!headsByDay.has(record.day)) headsByDay.set(record.day, []);
      headsByDay.get(record.day).push(record);
    } else {
      // what was sealed beyond the kept events is no longer expected
      headsByDay.set(record.day, (headsByDay.get(record.day) ?? []).filter((head) => head.position <= record.position));
      warnings.push({ code: "sealed_gap", message: `${record.day} was ${record.value} at ${record.time}, keeping ${record.position} event(s)` });
    }
  }
  for (const [day, heads] of headsByDay) {
    if (!heads.length) continue;
    const hashes = hashesByShard.get(`${day}.jsonl`);
    if (!hashes) {
      errors.push({ code: "sealed_shard_missing", message: `${day} was sealed at ${heads.at(-1).position} event(s) and is gone` });
      continue;
    }
    const broken = heads.find((head) => hashes[head.position - 1] !== head.value);
    if (broken) {
      const found = hashes.length < broken.position ? `the shard has ${hashes.length}` : "it has changed";
      errors.push({ code: "seal_mismatch", message: `${day} was sealed at event ${broken.position} on ${broken.time}; ${found}` });
    }
  }

  const last = standing(records);
  let unsealed = 0;
  for (const [name, hashes] of hashesByShard) {
    const day = path.basename(name, ".jsonl");
    if (!last || day > last.day) unsealed += hashes.length;
    else if (day === last.day) unsealed += Math.max(0, hashes.length - last.position);
  }
  return { file, records: records.length, lastSealedAt: records.at(-1)?.time ?? null, unsealedEvents: unsealed, errors, warnings };
}
