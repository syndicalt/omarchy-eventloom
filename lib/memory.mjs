// Memory: short summaries an agent writes of its own replies, and their
// recall. A log of tool calls says that something happened; the summary says
// what it was for. Summaries are filed under a project (the git repository
// the agent was working in, or failing that its directory) so that the next
// session there, by any agent, can start from them.
//
// Every recall is itself recorded, naming the summaries it returned: that is
// what lets the tapestry draw a thread from a memory to the session that
// used it.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { getSetting } from "./config.mjs";
import { listShardPaths } from "./paths.mjs";
import { findFirstEvent, readRecentEvents } from "./store.mjs";

export const SUMMARY_TYPE = "agent.reply.summarized";
export const RECALL_TYPE = "agent.memory.recalled";
// A summary is a few sentences. Longer text is the reply itself, not a
// summary of it, and is refused so the agent tries again.
export const SUMMARY_LIMIT = 600;
const TAG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_TAGS = 5;

export const BRIEF_SUMMARIES = 8;
export const RECALL_DAYS = 30;

// Off unless the owner turned it on: `eventloom config set memory on`, or
// EVENTLOOM_MEMORY=1 for one process. EVENTLOOM_MEMORY=0 turns it off
// whatever the setting says. A settings file that cannot be read leaves it
// off; doctor reports the file.
export function memoryEnabled(env = process.env) {
  if (env.EVENTLOOM_MEMORY === "0") return false;
  if (env.EVENTLOOM_MEMORY === "1") return true;
  try {
    return getSetting("memory") === "on";
  } catch {
    return false;
  }
}

// The repository a directory belongs to, or the directory itself.
export function projectOf(cwd = process.cwd()) {
  const dir = path.resolve(cwd);
  try {
    const top = execFileSync("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], {
      cwd: dir, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top || dir;
  } catch {
    // not a repository, no git, or the directory is gone
    return dir;
  }
}

// Which agent session a command typed by an agent belongs to. The adapters
// set EVENTLOOM_ACTOR and EVENTLOOM_SESSION_ID where they can; Claude Code
// names its session in the environment of every command it runs.
export function sessionFromEnv(env = process.env) {
  if (env.EVENTLOOM_ACTOR && env.EVENTLOOM_SESSION_ID) return { actor: env.EVENTLOOM_ACTOR, session: env.EVENTLOOM_SESSION_ID };
  if (env.CLAUDE_CODE_SESSION_ID) return { actor: "claude", session: env.CLAUDE_CODE_SESSION_ID };
  return null;
}

function parseTags(tags) {
  const list = [...new Set(String(tags ?? "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  if (list.length > MAX_TAGS) throw new Error(`at most ${MAX_TAGS} tags`);
  const bad = list.find((tag) => !TAG.test(tag));
  if (bad !== undefined) throw new Error(`"${bad}" is not a tag (lowercase letters, digits, - and _, up to 32 characters)`);
  return list;
}

function attributed({ actor, session, correlation, cwd, env, now }) {
  const known = sessionFromEnv(env);
  const who = actor ?? known?.actor ?? "user";
  const sessionId = session ?? known?.session;
  const dir = path.resolve(cwd ?? process.cwd());
  const payload = {
    correlation_id: correlation || env.EVENTLOOM_CORRELATION_ID || (sessionId ? `${who}-${sessionId}` : undefined),
    occurred_at: now.toISOString(),
    cwd: dir,
    project: projectOf(dir),
  };
  if (sessionId) payload.session_id = sessionId;
  if (payload.correlation_id === undefined) delete payload.correlation_id;
  return { actor: who, thread: sessionId ? `${who}-${sessionId}` : undefined, payload };
}

// The event for one summary. Throws on text that is empty or too long.
export function summaryDraft({ text, tags, actor, session, correlation, cwd, env = process.env, now = new Date() }) {
  const summary = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!summary) throw new Error("note needs a summary on standard input");
  if (summary.length > SUMMARY_LIMIT) {
    throw new Error(`the summary is ${summary.length} characters; say it in ${SUMMARY_LIMIT} or fewer`);
  }
  const { actor: who, thread, payload } = attributed({ actor, session, correlation, cwd, env, now });
  const tagList = parseTags(tags);
  return {
    type: SUMMARY_TYPE,
    actor: who,
    ...(thread ? { thread } : {}),
    payload: { ...payload, summary, ...(tagList.length ? { tags: tagList } : {}) },
  };
}

// Summaries, oldest first. `project` and `correlation` narrow them; with
// neither, every project's are returned.
export function recallSummaries({ project, correlation, tag, limit = BRIEF_SUMMARIES, days = RECALL_DAYS } = {}) {
  const shards = listShardPaths();
  const { events } = readRecentEvents(limit, (event) => {
    if (event.type !== SUMMARY_TYPE || typeof event.payload?.summary !== "string") return false;
    if (project && event.payload.project !== project) return false;
    if (correlation && event.payload.correlation_id !== correlation) return false;
    if (tag && !(Array.isArray(event.payload.tags) && event.payload.tags.includes(tag))) return false;
    return true;
  }, days === null ? shards : shards.slice(-days));
  return events;
}

// What a session is briefed with: the project's first summary, which is
// where the work began and what the rest follows from, and its latest ones.
// The first is looked for in the whole log, however old; it is null when
// there is none or when it is already among the latest.
export function briefingSummaries(project) {
  const latest = recallSummaries({ project });
  const first = findFirstEvent(
    (event) => event.type === SUMMARY_TYPE && typeof event.payload?.summary === "string" && event.payload.project === project,
    `"${SUMMARY_TYPE}"`,
  );
  return { first: first && !latest.some((event) => event.id === first.id) ? first : null, latest };
}

// The event recording that `summaries` were handed to a session.
export function recallDraft(summaries, { actor, session, correlation, cwd, env = process.env, now = new Date() }) {
  const { actor: who, thread, payload } = attributed({ actor, session, correlation, cwd, env, now });
  return {
    type: RECALL_TYPE,
    actor: who,
    ...(thread ? { thread } : {}),
    payload: { ...payload, recalled: summaries.map((event) => event.id), count: summaries.length },
  };
}

function when(event) {
  const at = new Date(event.payload.occurred_at ?? event.timestamp);
  if (Number.isNaN(at.getTime())) return "";
  const two = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

export function summaryLine(event) {
  const tags = Array.isArray(event.payload.tags) && event.payload.tags.length ? ` [${event.payload.tags.join(", ")}]` : "";
  return `- ${when(event)} ${event.actorId}${tags}: ${event.payload.summary}`;
}

// What an agent is told when a session opens: how to add to the memory, and
// what is in it for this project.
export function briefing({ first, latest }, project, noteCommand = "eventloom note") {
  const lines = [
    "Eventloom keeps a memory of what agents did in this project, shared by every agent that works here.",
    "After a reply in which you changed something, decided something or found something out, record a summary of it:",
    "what was done, what was decided, what is still open. One to three sentences, no secrets, nothing for small talk.",
    "",
    `  ${noteCommand} <<'EOF'`,
    "  <your summary>",
    "  EOF",
    "",
  ];
  if (latest.length) {
    lines.push(`What was recorded for ${project} (oldest first):`);
    if (first) lines.push(summaryLine(first), "  … (earlier summaries left out; the first is above, the latest follow)");
    lines.push(...latest.map(summaryLine), "");
  } else {
    lines.push(`Nothing has been recorded for ${project} yet.`, "");
  }
  lines.push("More: eventloom recall [--limit N] [--days N|all] [--tag <tag>] [--all]");
  return lines.join("\n");
}
