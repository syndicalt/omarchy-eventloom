// `eventloom doctor`: is the log healthy, and is each adapter really wired?
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeSettingsPath, missingClaudeHooks, readSettingsFile } from "./claude-settings.mjs";
import { createConnection } from "node:net";
import { getSetting, tapestryPort } from "./config.mjs";
import { readErrors } from "./error-log.mjs";
import { errorLogPath, expandHome, launchPagePath, listShardPaths, logDir } from "./paths.mjs";
import { SEAL_FORMAT, helperVersion, isSealed } from "./seal.mjs";
import { STALE_LOCK_MS, appendEvents, verifyShards } from "./store.mjs";

const RECENT_MS = 24 * 60 * 60 * 1000;
// "warn" is something to look at that does not stop events being recorded.
const pass = (name, detail) => ({ name, status: "ok", detail });
const warn = (name, detail) => ({ name, status: "warn", detail });
const fail = (name, detail) => ({ name, status: "fail", detail });

function checkLogDir() {
  const dir = logDir();
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (!stat) return pass("log directory", `${dir} (created on first event)`);
  const mode = stat.mode & 0o777;
  if (mode & 0o077) return fail("log directory", `${dir} is mode ${mode.toString(8)}; run: chmod 700 ${dir}`);
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch {
    return fail("log directory", `${dir} is not writable`);
  }
  return pass("log directory", dir);
}

function checkLocks(now) {
  const orphaned = listShardPaths()
    .map((shard) => `${shard}.lock`)
    .filter((lock) => now - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? now) >= STALE_LOCK_MS);
  if (!orphaned.length) return pass("locks", "none orphaned");
  return warn("locks", `a writer was killed mid-append, leaving ${orphaned.join(", ")}; the next append to that shard, or \`eventloom recover\`, removes it`);
}

async function checkIntegrity() {
  const { ok, reports, seal } = await verifyShards();
  const events = reports.reduce((total, report) => total + report.events, 0);
  const withWarning = (code) => reports.filter((report) => report.warnings.some((warning) => warning.code === code)).length;
  const unanchored = withWarning("unanchored_shard");
  const gaps = withWarning("acknowledged_gap");
  let summary = `${reports.length} shard(s), ${events} event(s)`;
  if (unanchored) summary += `, ${unanchored} unanchored`;
  if (gaps) summary += `, ${gaps} with an acknowledged gap`;
  if (seal) summary += `, sealed with ${seal.unsealedEvents} event(s) not yet sealed`;
  if (ok) return pass("integrity", summary);
  if (seal?.errors.length) return fail("integrity", `${summary}; the log does not match its seal: ${seal.errors[0].message} (see: eventloom seal status)`);
  const broken = reports.filter((report) => !report.ok).map((report) => path.basename(report.path));
  return fail("integrity", `${summary}; failed: ${broken.join(", ")} (see: eventloom verify)`);
}

// Seals and verifies a real event with the installed runtime, in a scratch
// directory so that a health check never adds to the real log.
async function checkRuntime() {
  const scratch = mkdtempSync(path.join(tmpdir(), "eventloom-doctor-"));
  try {
    const probe = path.join(scratch, "probe.jsonl");
    await appendEvents([{ type: "eventloom.doctor.probed", actorId: "eventloom", threadId: "doctor", payload: {} }], probe);
    const { ok } = await verifyShards([probe], { checkLinks: false });
    return ok ? pass("runtime", "sealed and verified a probe event") : fail("runtime", "probe event did not verify");
  } catch (err) {
    return fail("runtime", err.message);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function checkRecentErrors(now) {
  const recent = readErrors().filter((entry) => now - Date.parse(entry.at) < RECENT_MS);
  if (!recent.length) return pass("recent errors", "none in the last 24h");
  const latest = recent.at(-1);
  return warn("recent errors", `${recent.length} in the last 24h, latest from ${latest.source}: ${latest.message} (${errorLogPath()})`);
}

function checkAdapter(adapter) {
  const name = `adapter: ${adapter.agent}`;
  const hookPath = expandHome(adapter.hook_path);
  if (!existsSync(expandHome(adapter.agent_home))) return pass(name, "agent not present on this machine");
  if (!existsSync(hookPath)) return fail(name, `${hookPath} is not installed; run install.sh`);
  if (adapter.method !== "claude-hooks") return pass(name, hookPath);
  try {
    const missing = missingClaudeHooks(readSettingsFile(claudeSettingsPath()));
    if (missing.length) return fail(name, `not registered for ${missing.join(", ")}; run: eventloom wire-claude-hooks`);
  } catch (err) {
    return fail(name, err.message);
  }
  return pass(name, `${hookPath}, registered in settings.json`);
}

// Sealing fails quietly, one error-log line per attempt, so a helper that
// cannot be run has to be said here.
function checkSeal() {
  if (!isSealed()) return pass("sealed mode", "off (see: eventloom seal enable)");
  const version = helperVersion();
  if (version === null) return fail("sealed mode", "on, but the helper cannot be run; set it up again (see: eventloom seal enable)");
  if (version !== SEAL_FORMAT) return warn("sealed mode", `on; the helper is format ${version} and this eventloom writes ${SEAL_FORMAT}, run the setup again`);
  return pass("sealed mode", "on");
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 500 });
    const settle = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function checkMemory() {
  try {
    return getSetting("memory") === "on"
      ? pass("memory", "on: new sessions are briefed and asked for summaries")
      : pass("memory", "off (turn it on with: eventloom config set memory on)");
  } catch (err) {
    return fail("memory", err.message);
  }
}

// A tapestry server leaves a launch page for as long as it runs, so a port
// that answers without one belongs to something else.
async function checkTapestry() {
  let port;
  try {
    port = tapestryPort();
  } catch (err) {
    return fail("tapestry", err.message);
  }
  if (!(await listening(port))) return pass("tapestry", `port ${port}, not running`);
  if (existsSync(launchPagePath(port))) return pass("tapestry", `port ${port}, running`);
  return warn("tapestry", `port ${port} is held by another program; choose another with: eventloom config set tapestry_port <n>`);
}

function loadAdapters() {
  return JSON.parse(readFileSync(new URL("./adapters.json", import.meta.url), "utf8")).adapters;
}

export async function runDoctor(now = Date.now()) {
  return [
    checkLogDir(),
    checkLocks(now),
    await checkIntegrity(),
    await checkRuntime(),
    checkRecentErrors(now),
    checkSeal(),
    checkMemory(),
    await checkTapestry(),
    ...loadAdapters().map(checkAdapter),
  ];
}
