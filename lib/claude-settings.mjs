// Registers the eventloom hook in Claude Code's settings.json and removes it
// again. The file belongs to the user: it is never replaced when it cannot be
// parsed, every other key and hook is carried through unchanged, and each
// rewrite is atomic and leaves the previous contents beside it.
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CLAUDE_HOOK_EVENTS } from "./claude-hook.mjs";
import { isPlainObject } from "./shape.mjs";

// Hooks whose matcher selects a tool; the session hooks take none.
const TOOL_HOOKS = new Set(["PostToolUse", "PostToolUseFailure"]);

// Exactly the commands this module has written, in this release
// (`sh '<path>/eventloom-hook.sh'`) and earlier ones (`bash '<path>' <event>`).
// A user's own hook that merely mentions the script is not one of them.
const OWN_COMMAND = /^(?:sh|bash) '(?:[^']|'\\'')*\/eventloom-hook\.sh'(?: \w+)?$/;

export function claudeSettingsPath() {
  return path.join(homedir(), ".claude", "settings.json");
}

function claudeHookPath() {
  return path.join(homedir(), ".claude", "hooks", "eventloom-hook.sh");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function hookCommand(hookPath) {
  return `sh ${shellQuote(hookPath)}`;
}

function isEventloomHook(hook) {
  return typeof hook?.command === "string" && OWN_COMMAND.test(hook.command);
}

// Claude's shape is hooks: { <Event>: [ { matcher?, hooks: [ ... ] } ] }.
// Anything else is the user's to fix; editing around it would be a guess.
function hookTable(settings) {
  const table = settings.hooks ?? {};
  if (!isPlainObject(table)) throw new Error('"hooks" in Claude settings is not an object; left unchanged');
  for (const [event, entries] of Object.entries(table)) {
    if (!Array.isArray(entries)) throw new Error(`"hooks.${event}" in Claude settings is not a list; left unchanged`);
  }
  return table;
}

// Remove every eventloom command, whichever event or release registered it.
// Only an entry or event that this empties is dropped; one the user left
// empty stays as it was.
export function unwireClaudeHooks(settings) {
  const next = structuredClone(settings);
  let removed = 0;
  for (const [event, entries] of Object.entries(hookTable(next))) {
    const kept = [];
    let removedHere = 0;
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const others = hooks.filter((hook) => !isEventloomHook(hook));
      if (others.length === hooks.length) kept.push(entry);
      else if (others.length) kept.push({ ...entry, hooks: others });
      removedHere += hooks.length - others.length;
    }
    if (removedHere === 0) continue;
    removed += removedHere;
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (removed && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

// Idempotent: unwire first, so a re-run refreshes the path, migrates entries
// from older releases, and never duplicates.
export function wireClaudeHooks(settings, hookPath = claudeHookPath()) {
  const next = unwireClaudeHooks(settings).settings;
  next.hooks ??= {};
  const hook = { type: "command", command: hookCommand(hookPath), timeout: 15 };
  for (const event of CLAUDE_HOOK_EVENTS) {
    const entry = TOOL_HOOKS.has(event) ? { matcher: "*", hooks: [hook] } : { hooks: [hook] };
    (next.hooks[event] ??= []).push(entry);
  }
  return next;
}

// The hook events not registered to run exactly this script. An entry that
// points at another path, or whose matcher limits it to some tools, would
// record nothing or only part, so neither counts.
export function missingClaudeHooks(settings, hookPath = claudeHookPath()) {
  const table = hookTable(settings);
  const command = hookCommand(hookPath);
  return CLAUDE_HOOK_EVENTS.filter((event) => {
    return !(table[event] ?? []).some((entry) => {
      const everyTool = entry?.matcher === undefined || entry.matcher === "" || entry.matcher === "*";
      return everyTool && Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook?.command === command);
    });
  });
}

// A missing file is an empty configuration. Anything else that cannot be
// read as a JSON object is an error for the caller to surface.
export function readSettingsFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    // Parser excerpts can contain credentials from the user's settings.
    throw new Error(`${file} is not valid JSON; left unchanged`, { cause: err });
  }
  if (!isPlainObject(settings)) {
    throw new Error(`${file} does not hold a JSON object; left unchanged`);
  }
  return settings;
}

// Where a write to `file` must land: the file itself, or what it links to.
// A symlinked settings.json (a dotfiles checkout) is followed even when its
// target does not exist yet, so the link is never replaced by a regular file.
function writeTarget(file) {
  let target = file;
  for (let hops = 0; hops < 8 && lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink(); hops++) {
    target = path.resolve(path.dirname(target), readlinkSync(target));
  }
  return target;
}

// Returns false, and writes nothing, when the file already has this content.
// Otherwise the previous contents are kept beside it as
// settings.json.eventloom-backup and the new file is renamed into place.
export function writeSettingsFile(file, settings) {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  const target = writeTarget(file);
  const existing = statSync(target, { throwIfNoEntry: false });
  if (existing) {
    if (readFileSync(target, "utf8") === text) return false;
    copyFileSync(target, `${file}.eventloom-backup`);
  }
  const mode = existing ? existing.mode & 0o777 : 0o600;
  mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.eventloom-tmp-${process.pid}`; // per process, so two runs cannot share it
  writeFileSync(staged, text, { mode });
  chmodSync(staged, mode); // the mode given to writeFileSync is cut down by the umask
  renameSync(staged, target);
  return true;
}
