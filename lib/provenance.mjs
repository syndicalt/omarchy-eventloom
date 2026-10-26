// Where a session ran: host, Omarchy release, and the git references of its
// working directory. Attached once, to the event that opens a session.
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

const SESSION_OPENERS = new Set(["agent.session.started", "agent.session.resumed"]);

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // not installed, not a repository, or too slow: provenance is optional
    return null;
  }
}

// A session can open before the repository is trusted. Read references only:
// status/index/worktree inspection can execute repository-configured fsmonitor
// commands or clean filters, even with --no-optional-locks and a timeout.
// Do not infer git_dirty. Adapter-supplied fields and old events still stand.
function gitProvenance(cwd) {
  const branch = run("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], cwd)?.trim();
  // No ^{commit} peeling or object inspection: reference metadata is enough.
  const commit = run("git", ["--no-optional-locks", "rev-parse", "--verify", "HEAD"], cwd)?.trim();
  const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit ?? "") ? commit : undefined;
  return {
    git_branch: branch || (oid ? "(detached)" : undefined),
    git_commit: oid?.slice(0, 12),
  };
}

// Fills only the fields the adapter did not already supply.
export function withSessionProvenance(type, payload) {
  if (!SESSION_OPENERS.has(type)) return payload;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const found = {
    host: hostname(),
    omarchy: run("omarchy-version", [])?.trim() || undefined,
    ...(cwd ? gitProvenance(cwd) : {}),
  };
  const filled = { ...payload };
  for (const [field, value] of Object.entries(found)) {
    if (filled[field] === undefined && value !== undefined) filled[field] = value;
  }
  return filled;
}
