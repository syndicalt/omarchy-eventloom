// Pure Claude settings edits. Callers must refuse to write when the on-disk
// file cannot be parsed; these functions never invent a replacement document.

export const CLAUDE_HOOK_EVENTS = [
  ["SessionStart", "session_start"],
  ["Stop", "session_stop"],
  ["PostToolUse", "post_tool"],
];

export function shSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function hookCommand(absHook, arg) {
  return `bash ${shSingleQuote(absHook)} ${arg}`;
}

function isOurHook(command, arg) {
  return typeof command === "string"
    && command.includes("eventloom-hook.sh")
    && command.endsWith(` ${arg}`);
}

export function parseSettingsText(text, settingsPath) {
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    const error = new Error(`refusing to rewrite ${settingsPath}: ${err.message}`);
    error.code = "settings_preserved";
    throw error;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    const error = new Error(`refusing to rewrite ${settingsPath}: root is not an object`);
    error.code = "settings_preserved";
    throw error;
  }
  return settings;
}

export function mergeClaudeHooks(settings, absHook) {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  let added = 0;
  let refreshed = 0;
  for (const [event, arg] of CLAUDE_HOOK_EVENTS) {
    const entries = (next.hooks[event] ??= []);
    const command = hookCommand(absHook, arg);
    let found = false;
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (!isOurHook(hook.command, arg)) continue;
        hook.command = command;
        found = true;
        refreshed++;
      }
    }
    if (!found) {
      entries.push({ matcher: "*", hooks: [{ type: "command", command, timeout: 10 }] });
      added++;
    }
  }
  return { settings: next, added, refreshed };
}

export function stripClaudeHooks(settings) {
  const next = structuredClone(settings ?? {});
  if (!next.hooks || typeof next.hooks !== "object") return { settings: next, removed: 0 };
  let removed = 0;
  for (const event of Object.keys(next.hooks)) {
    const kept = [];
    for (const entry of next.hooks[event] ?? []) {
      const hooks = [];
      for (const hook of entry.hooks ?? []) {
        if (typeof hook.command === "string" && hook.command.includes("eventloom-hook.sh")) removed++;
        else hooks.push(hook);
      }
      if (hooks.length) kept.push({ ...entry, hooks });
    }
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  return { settings: next, removed };
}

export function claudeHooksWired(settings) {
  const hooks = settings?.hooks ?? {};
  const missing = [];
  for (const [event, arg] of CLAUDE_HOOK_EVENTS) {
    const entries = hooks[event] ?? [];
    const wired = entries.some((entry) => (entry.hooks ?? []).some((hook) => isOurHook(hook.command, arg)));
    if (!wired) missing.push(event);
  }
  return { wired: missing.length === 0, missing };
}
