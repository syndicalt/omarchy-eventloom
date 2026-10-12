import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A scratch directory that is removed when the test (or test file) finishes.
export function tempDir(t, label) {
  const dir = mkdtempSync(path.join(tmpdir(), `eventloom-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Point the log at a fresh directory for one test and restore it afterwards.
export function useTempLogDir(t) {
  const previous = process.env.EVENTLOOM_LOG_DIR;
  process.env.EVENTLOOM_LOG_DIR = path.join(tempDir(t, "store"), "logs");
  t.after(() => {
    if (previous === undefined) delete process.env.EVENTLOOM_LOG_DIR;
    else process.env.EVENTLOOM_LOG_DIR = previous;
  });
  return process.env.EVENTLOOM_LOG_DIR;
}

export function note(text, actorId = "tester") {
  return { type: "agent.note.added", actorId, threadId: "t", payload: { text } };
}

// Wait for something another process does, without guessing how long it takes.
export async function until(check, { timeoutMs = 10_000, everyMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
