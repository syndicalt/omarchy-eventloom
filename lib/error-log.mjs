// A plain-text record of logging failures. Adapters run with their output
// discarded, so without this file a broken log is indistinguishable from an
// idle one.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { errorLogPath } from "./paths.mjs";
import { redactString } from "./redact.mjs";

// Past MAX_BYTES the file is cut back to its newest KEPT_LINES entries before
// the next one is added, which at MAX_MESSAGE characters each is well under
// the limit again.
const MAX_BYTES = 256 * 1024;
const MAX_MESSAGE = 1000;
const KEPT_LINES = 100;

// Messages can quote rejected input, so they get the same redaction as events.
export function recordError(source, message) {
  const file = errorLogPath();
  const text = redactString(String(message).replace(/\s+/g, " ")).slice(0, MAX_MESSAGE);
  const line = `${new Date().toISOString()}\t${source}\t${text}\n`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (statSync(file, { throwIfNoEntry: false })?.size > MAX_BYTES) {
      const recent = readFileSync(file, "utf8").trimEnd().split("\n").slice(-KEPT_LINES).join("\n") + "\n";
      writeFileSync(file, recent, { mode: 0o600 });
    }
    appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // Last resort: there is nowhere left to report that reporting failed.
  }
}

// Newest last. Each entry is { at, source, message }.
export function readErrors() {
  let text;
  try {
    text = readFileSync(errorLogPath(), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter(Boolean).map((line) => {
    const [at, source, ...message] = line.split("\t");
    return { at, source, message: message.join("\t") };
  });
}
