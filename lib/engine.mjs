// eventloom engine — shared helpers for the shim and adapters.
// Path policy, provenance, redaction, and event-type vocabulary live here.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

export const LOG_DIR = path.join(homedir(), ".local", "state", "omarchy", "agents", "logs");
const SHARD_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// Local calendar day. UTC dates split an evening session across two shards.
export function localDay(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayPath(now = new Date()) {
  return path.join(LOG_DIR, `${localDay(now)}.jsonl`);
}

export function listShardPaths(dir = LOG_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => SHARD_NAME.test(name)).sort().map((name) => path.join(dir, name));
}

// The log holds tool and approval history. Keep the directory private even
// when the process umask would otherwise create a world-readable tree.
export function ensureLogDir() {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(LOG_DIR, 0o700); } catch { /* best effort on unusual filesystems */ }
}

export function secureLogFile(file) {
  try {
    if (file && existsSync(file)) chmodSync(file, 0o600);
  } catch { /* best effort */ }
}

// --- Provenance -------------------------------------------------------------
// Every session.started event carries Omarchy context (consideration 6).

let omarchyVersionCache;

export function omarchyVersion() {
  if (omarchyVersionCache !== undefined) return omarchyVersionCache;
  try {
    omarchyVersionCache = execFileSync("omarchy", ["--version"], { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    omarchyVersionCache = null;
  }
  return omarchyVersionCache;
}

export function gitProvenance(cwd) {
  const out = {};
  if (!cwd) return out;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", timeout: 1000 });
    out.git_branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", timeout: 1000 }).trim();
    out.git_commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8", timeout: 1000 }).trim();
    out.git_dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 1000 }).trim().length > 0;
  } catch {
    // not a repo or git failed — provenance is best-effort
  }
  return out;
}

export function sessionProvenance(agent, cwd) {
  return {
    agent,
    host: hostname(),
    omarchy: omarchyVersion(),
    cwd: cwd ?? process.cwd(),
    ...gitProvenance(cwd ?? process.cwd()),
  };
}

// --- Redaction (consideration 4) --------------------------------------------
// Secrets must never be sealed into the hash chain; sealing is irreversible.

const REDACT_PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, replacement: "[REDACTED_PEM]" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED_JWT]" },
  { re: /\b(?:sk|pk)(?:-[A-Za-z0-9_-]{8,}){1,}\b/g, replacement: "[REDACTED_KEY]" },
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{16,})\b/g, replacement: "[REDACTED_GH]" },
  { re: /\bxox[baprsce]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED_SLACK]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS]" },
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: "[REDACTED_GOOGLE]" },
  { re: /\bnpm_[A-Za-z0-9]{16,}\b/g, replacement: "[REDACTED_NPM]" },
  { re: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replacement: "$1[REDACTED]@" },
  // Longer names first so access_token is not missed by a \btoken boundary.
  { re: /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|authorization|passwd|password|secret|token)["'\s:=]+(?:bearer\s+)?)([^\s"'`,;}<>]{8,})/gi, replacement: "$1[REDACTED]" },
  { re: /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|passwd|password|secret|token)\s+(?:is|was)\s+)(\S{6,})/gi, replacement: "$1[REDACTED]" },
];

export function redactString(s) {
  let out = s;
  for (const { re, replacement } of REDACT_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), replacement);
  }
  return out;
}

const SENSITIVE_KEY = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|authorization|passwd|password|secret|token)$/i;

export function redact(value, depth = 0, key = "") {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") {
    // Structured payloads split the name from the value, so the assignment
    // regex never sees them together. A sensitive key redacts its own string.
    if (key && SENSITIVE_KEY.test(key) && value.length >= 6) return "[REDACTED]";
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[redactString(k)] = redact(v, depth + 1, k);
    return out;
  }
  return value;
}

// --- Capture mode (consideration 4) ------------------------------------------
// EVENTLOOM_MODE: full (default) | summary | metadata

export function captureMode() {
  const m = (process.env.EVENTLOOM_MODE || "full").toLowerCase();
  return ["full", "summary", "metadata"].includes(m) ? m : "full";
}

function clipStrings(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "…" : value;
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipStrings(v, depth + 1);
    return out;
  }
  return value;
}

export function applyCaptureMode(payload) {
  const mode = captureMode();
  if (mode === "metadata") {
    // keep only structural fields, never content
    const keep = {};
    for (const k of ["agent", "session_id", "correlation_id", "cwd", "host", "omarchy", "git_branch", "git_commit", "git_dirty", "tool", "tool_name", "model", "status", "exit_code", "duration_ms"]) {
      if (payload[k] !== undefined) keep[k] = payload[k];
    }
    return redact(keep);
  }
  const redacted = redact(payload);
  // summary clips every nested string; full keeps redacted content intact
  return mode === "summary" ? clipStrings(redacted) : redacted;
}

// --- Event vocabulary (consideration 3) ---------------------------------------
// Envelope stays eventloom-strict; agent specifics live in payload.

export const EventTypes = {
  sessionStarted: "agent.session.started",
  sessionResumed: "agent.session.resumed",
  sessionCompleted: "agent.session.completed",
  sessionFailed: "agent.session.failed",
  modelStarted: "agent.model.started",
  modelCompleted: "agent.model.completed",
  toolStarted: "agent.tool.started",
  toolCompleted: "agent.tool.completed",
  toolFailed: "agent.tool.failed",
  approvalRequested: "agent.approval.requested",
  approvalResolved: "agent.approval.resolved",
  fileMutated: "agent.file.mutated",
  gitMutated: "agent.git.mutated",
  handoff: "agent.handoff",
  note: "agent.note.added",
};

// --- Adapter manifest (considerations 1 & 7) ----------------------------------
// Community-extensible: an adapter declares the agent it captures, how, and
// which hook file it installs. The doctor command checks each entry.

export function adaptersManifestPath() {
  return path.join(homedir(), ".local", "lib", "eventloom", "adapters.json");
}

export function loadAdapters() {
  const p = adaptersManifestPath();
  if (!existsSync(p)) return { adapters: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { adapters: [] };
  }
}
