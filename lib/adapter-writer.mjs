// Ordered, nonblocking native-plugin writes. CLI stdin carries every event;
// the adapter never writes the log directly or prints into an agent session.
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { recordError } from "./error-log.mjs";

export function adapterWriter(actor) {
  const cli = path.join(homedir(), ".local/bin/eventloom");
  let queue = [], busy = false;
  function send(events, done) {
    let child;
    try {
      child = spawn(cli, ["ingest"], { detached: true, stdio: ["pipe", "ignore", "pipe"] });
    } catch { recordError(`${actor}-adapter`, "could not launch eventloom ingest"); done(); return; }
    let finished = false;
    const finish = () => { if (!finished) { finished = true; done(); } };
    child.on("error", () => { recordError(`${actor}-adapter`, "could not launch eventloom ingest"); finish(); });
    child.on("close", (code) => { if (code) recordError(`${actor}-adapter`, `eventloom ingest exited ${code}`); finish(); });
    child.stderr.resume(); // the CLI records its detailed, redacted errors privately
    child.stdin.on("error", () => {});
    child.stdin.end(events.map(JSON.stringify).join("\n") + "\n");
    child.unref();
    child.stdin.unref?.();
    child.stderr.unref?.();
  }
  function flush() {
    if (busy || !queue.length) return;
    busy = true;
    const batch = queue;
    queue = [];
    send(batch, () => { busy = false; flush(); });
  }
  return {
    write(event) {
      if (process.env.EVENTLOOM_DISABLE === "1") return;
      queue.push(event);
      flush();
    },
    close() {
      if (!queue.length) return;
      const batch = queue;
      queue = [];
      send(batch, () => {});
    },
    brief(session, cwd) {
      if (process.env.EVENTLOOM_DISABLE === "1" || process.env.EVENTLOOM_MEMORY === "0") return Promise.resolve("");
      return new Promise((resolve) => {
        execFile(cli, ["brief", "--actor", actor, "--session", session, "--cwd", cwd],
          { timeout: 2000, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout) => {
            if (error) { recordError(`${actor}-adapter`, "eventloom brief failed or timed out"); resolve(""); }
            else resolve(stdout.trim());
          });
      });
    },
  };
}
