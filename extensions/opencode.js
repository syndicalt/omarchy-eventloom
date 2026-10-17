// omarchy-eventloom OpenCode adapter — local, dependency-free plugin loader.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const Eventloom = async (context) => {
  if (process.env.EVENTLOOM_DISABLE === "1") return {};
  const key = Symbol.for("omarchy-eventloom.opencode");
  const loaded = globalThis[key] ??= new Set();
  const directory = context.directory || process.cwd();
  if (loaded.has(directory)) return {};
  loaded.add(directory);
  try {
    const { createOpenCodeAdapter } = await import(pathToFileURL(path.join(homedir(), ".local/lib/eventloom/lib/opencode-adapter.mjs")).href);
    const hooks = createOpenCodeAdapter(context);
    const event = hooks.event;
    hooks.event = async (input) => {
      await event?.(input);
      if (["server.instance.disposed", "global.disposed"].includes(input?.event?.type)) loaded.delete(directory);
    };
    const dispose = hooks.dispose;
    hooks.dispose = async () => { loaded.delete(directory); await dispose?.(); };
    return hooks;
  } catch {
    loaded.delete(directory);
    // Import failures happen before the installed error logger can run.
    const log = process.env.EVENTLOOM_LOG_DIR || path.join(homedir(), ".local/state/omarchy/agents/logs");
    try {
      mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
      appendFileSync(path.join(path.dirname(log), "eventloom-errors.log"), `${new Date().toISOString()}\topencode-adapter\tcould not load the installed adapter; run install.sh\n`, { mode: 0o600 });
    } catch { /* The plugin must not stop OpenCode even when reporting fails. */ }
    return {};
  }
};
