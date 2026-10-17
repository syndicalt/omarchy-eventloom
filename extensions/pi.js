// omarchy-eventloom Pi adapter — dependency-free native extension loader.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function eventloomPi(pi) {
  if (process.env.EVENTLOOM_DISABLE === "1") return;
  try {
    const { createPiAdapter } = await import(pathToFileURL(path.join(homedir(), ".local/lib/eventloom/lib/pi-adapter.mjs")).href);
    createPiAdapter(pi);
  } catch {
    const log = process.env.EVENTLOOM_LOG_DIR || path.join(homedir(), ".local/state/omarchy/agents/logs");
    try {
      mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
      appendFileSync(path.join(path.dirname(log), "eventloom-errors.log"), `${new Date().toISOString()}\tpi-adapter\tcould not load the installed adapter; run install.sh\n`, { mode: 0o600 });
    } catch { /* Nothing in the recorder may stop Pi from starting. */ }
  }
}
