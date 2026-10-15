// Where eventloom keeps its state. Shards are named for the local calendar
// day: a UTC date would split one evening's session across two files.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SHARD_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// EVENTLOOM_LOG_DIR relocates the log (tests, sandboxes, alternate volumes).
export function logDir() {
  return process.env.EVENTLOOM_LOG_DIR
    || path.join(homedir(), ".local", "state", "omarchy", "agents", "logs");
}

export function localDay(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function shardPath(now = new Date()) {
  return path.join(logDir(), `${localDay(now)}.jsonl`);
}

export function isShardPath(file) {
  return SHARD_NAME.test(path.basename(file)) && path.resolve(path.dirname(file)) === path.resolve(logDir());
}

// Oldest first; the names sort chronologically.
export function listShardPaths() {
  const dir = logDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => SHARD_NAME.test(name)).sort().map((name) => path.join(dir, name));
}

// Adapters discard their own stderr so they can never disturb the agent they
// observe. Failures land here instead, and `eventloom doctor` reads it back.
export function errorLogPath() {
  return path.join(path.dirname(logDir()), "eventloom-errors.log");
}

// The page that opens the Tapestry served on `port`: beside the log, in a
// directory only its owner can enter. It exists while that server runs.
export function launchPagePath(port) {
  return path.join(path.dirname(logDir()), "tapestry", `launch-${port}.html`);
}

export function expandHome(file) {
  return file.replace(/^~(?=\/|$)/, homedir());
}
