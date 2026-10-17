// Codex's user hooks are JSON, separate from config.toml. Preserve all other
// hooks and fields. Trust remains Codex's to review through /hooks.
import { homedir } from "node:os";
import path from "node:path";
import { hookCommand } from "./claude-settings.mjs";
import { CODEX_HOOK_EVENTS } from "./codex-hook.mjs";
import { isPlainObject } from "./shape.mjs";

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(homedir(), ".codex");
}
export const codexSettingsPath = () => path.join(codexHome(), "hooks.json");
export const codexHookPath = () => path.join(codexHome(), "hooks", "eventloom-codex-hook.sh");
const OWN_COMMAND = /^sh '(?:[^']|'\\'')*\/eventloom-codex-hook\.sh'$/;

function hookTable(settings) {
  const table = settings.hooks ?? {};
  if (!isPlainObject(table)) throw new Error('"hooks" in Codex hooks.json is not an object; left unchanged');
  for (const [event, entries] of Object.entries(table)) {
    if (!Array.isArray(entries)) throw new Error(`"hooks.${event}" in Codex hooks.json is not a list; left unchanged`);
    for (const entry of entries) {
      if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) throw new Error(`"hooks.${event}" in Codex hooks.json has an invalid matcher group; left unchanged`);
      for (const hook of entry.hooks) {
        if (!isPlainObject(hook) || typeof hook.type !== "string" || hook.type === "command" && typeof hook.command !== "string") {
          throw new Error(`"hooks.${event}" in Codex hooks.json has an invalid handler; left unchanged`);
        }
      }
    }
  }
  return table;
}

export function unwireCodexHooks(settings) {
  const next = structuredClone(settings);
  let removed = 0;
  for (const [event, entries] of Object.entries(hookTable(next))) {
    const kept = [];
    let removedHere = 0;
    for (const entry of entries) {
      const others = entry.hooks.filter((hook) => !OWN_COMMAND.test(hook?.command ?? ""));
      const count = entry.hooks.length - others.length;
      if (!count) kept.push(entry);
      else if (others.length) kept.push({ ...entry, hooks: others });
      removedHere += count;
    }
    if (!removedHere) continue;
    removed += removedHere;
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (removed && !Object.keys(next.hooks).length) delete next.hooks;
  return { settings: next, removed };
}

export function wireCodexHooks(settings, file = codexHookPath()) {
  const next = unwireCodexHooks(settings).settings;
  next.hooks ??= {};
  for (const event of CODEX_HOOK_EVENTS) {
    (next.hooks[event] ??= []).push({ hooks: [{ type: "command", command: hookCommand(file), timeout: 15 }] });
  }
  return next;
}

export function missingCodexHooks(settings, file = codexHookPath()) {
  const table = hookTable(settings);
  const command = hookCommand(file);
  return CODEX_HOOK_EVENTS.filter((event) => !(table[event] ?? []).some((entry) => {
    const every = entry.matcher === undefined || entry.matcher === "" || entry.matcher === "*";
    return every && entry.enabled !== false && entry.hooks.some((hook) => hook.type === "command" && hook.command === command && hook.enabled !== false);
  }));
}
