// Where a session ran: host, Omarchy release, and the git state of its
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

// --no-optional-locks: never take index.lock in a repository the agent is using
function gitProvenance(cwd) {
  const status = run("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], cwd);
  if (status === null) return {};
  const lines = status.split("\n").filter(Boolean);
  const header = (name) => lines.find((line) => line.startsWith(`# branch.${name} `))?.split(" ")[2];
  const commit = header("oid");
  return {
    git_branch: header("head"),
    git_commit: commit && commit !== "(initial)" ? commit.slice(0, 12) : undefined,
    git_dirty: lines.some((line) => !line.startsWith("#")),
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
