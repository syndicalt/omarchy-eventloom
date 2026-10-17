// Register bundled adapters without launching agents or installing packages.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentCapabilities } from "./agents.mjs";
import { claudeSettingsPath, missingClaudeHooks, readSettingsFile, wireClaudeHooks, writeSettingsFile } from "./claude-settings.mjs";
import { codexHome, codexHookPath, codexSettingsPath, missingCodexHooks, wireCodexHooks } from "./codex-settings.mjs";
import { NATIVE_HOOKS, missingNativeHooks, nativeHookPaths, wireNativeHooks } from "./native-hooks.mjs";
import { opencodeConfigDir, opencodePluginPath } from "./opencode-adapter.mjs";
import { piAgentDir, piExtensionPath } from "./pi-adapter.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const home = (...parts) => path.join(homedir(), ...parts);

function installAsset(source, destination, marker) {
  const content = readFileSync(path.join(ROOT, source));
  if (existsSync(destination)) {
    const previous = readFileSync(destination);
    if (content.equals(previous)) return false;
    if (!previous.toString("utf8").includes(marker)) throw new Error(`${destination} already exists and is not Eventloom's adapter; left unchanged`);
  } else if (lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error(`${destination} is a broken link; left unchanged`);
  }
  // Follow dotfile symlinks, and preserve their target's permissions.
  const target = existsSync(destination) ? realpathSync(destination) : destination;
  mkdirSync(path.dirname(target), { recursive: true });
  const mode = statSync(target, { throwIfNoEntry: false })?.mode & 0o777;
  const staged = `${target}.eventloom-tmp-${process.pid}`;
  writeFileSync(staged, content, { mode: mode || (source.endsWith(".sh") ? 0o755 : 0o644) });
  renameSync(staged, target);
  return true;
}

// Add absent registrations, retaining existing matchers, disabled flags,
// handler options and user hooks verbatim. The wire function validates first.
function addMissing(settings, wire, key = "hooks") {
  const expected = wire(settings);
  const next = structuredClone(settings);
  for (const [field, value] of Object.entries(expected)) if (field !== key && !(field in next)) next[field] = value;
  const table = next[key] ??= {};
  for (const [event, entries] of Object.entries(expected[key])) {
    if (!Array.isArray(entries)) continue;
    const entry = entries.at(-1);
    const handler = (entry.hooks ?? [entry])[0];
    const command = handler.command ?? handler.bash;
    const registered = (table[event] ?? []).some(item => (item.hooks ?? [item]).some(hook => (hook.command ?? hook.bash) === command));
    if (!registered) (table[event] ??= []).push(entry);
  }
  return next;
}

function jobs() {
  const claude = home(".claude");
  const omp = home(".omp/agent");
  return [
    { agent: "omp", present: existsSync(omp), source: "extensions/eventloom.ts", target: path.join(omp, "extensions/eventloom.ts"), marker: "eventloom adapter for omp" },
    { agent: "claude", present: existsSync(claude), source: "hooks/eventloom-hook.sh", target: path.join(claude, "hooks/eventloom-hook.sh"), marker: "eventloom adapter for Claude Code", config: claudeSettingsPath(), wire: wireClaudeHooks, missing: missingClaudeHooks, failure: "could not register the Claude hooks" },
    { agent: "codex", present: existsSync(codexHome()), source: "hooks/eventloom-codex-hook.sh", target: codexHookPath(), marker: "Eventloom's Codex adapter", config: codexSettingsPath(), wire: wireCodexHooks, missing: missingCodexHooks },
    { agent: "opencode", present: existsSync(opencodeConfigDir()) || Boolean(process.env.OPENCODE_CONFIG_DIR && existsSync(process.env.OPENCODE_CONFIG_DIR)), source: "extensions/opencode.js", target: opencodePluginPath(), marker: "omarchy-eventloom OpenCode adapter" },
    { agent: "pi", present: existsSync(piAgentDir()), source: "extensions/pi.js", target: piExtensionPath(), marker: "omarchy-eventloom Pi adapter" },
    ...Object.keys(NATIVE_HOOKS).map(agent => {
      const paths = nativeHookPaths(agent);
      return { agent, present: existsSync(paths.home), source: "hooks/eventloom-native-hook.sh", target: paths.script, marker: "Native observer: one valid neutral response", config: paths.config,
        key: NATIVE_HOOKS[agent].shape === "named" ? "omarchy-eventloom" : "hooks",
        wire: settings => wireNativeHooks(settings, agent), missing: settings => missingNativeHooks(settings, agent) };
    }),
  ];
}

export function setupAgents() {
  const results = [];
  for (const job of jobs()) {
    const result = { agent: job.agent, status: "not-detected", changed: false };
    results.push(result);
    if (!job.present) continue;
    try {
      // Put a neutral wrapper in place even if registration cannot be parsed.
      result.changed = installAsset(job.source, job.target, job.marker);
      if (job.config) {
        const settings = readSettingsFile(job.config);
        const next = addMissing(settings, job.wire, job.key);
        if (JSON.stringify(settings) !== JSON.stringify(next)) result.changed = writeSettingsFile(job.config, next) || result.changed;
        const missing = job.missing(next);
        if (missing.length) result.attention = `Existing settings restrict ${missing.join(", ")}; left unchanged`;
      }
      result.status = "registered";
      if (job.agent === "codex") result.review = "review and trust Eventloom's hooks in Codex /hooks if not already trusted";
    } catch (error) {
      result.status = "error";
      result.detail = `${job.failure ?? `could not register ${job.agent}`}: ${error.message}`;
    }
  }
  for (const agent of agentCapabilities().filter(item => !item.native)) results.push({ agent: agent.agent, status: "process-only", changed: false });
  return { ok: !results.some(item => item.status === "error"), changed: results.some(item => item.changed), agents: results };
}

export function setupSummary(result) {
  const registered = result.agents.filter(item => item.status === "registered");
  const absent = result.agents.filter(item => item.status === "not-detected");
  const processOnly = result.agents.filter(item => item.status === "process-only");
  return [
    `Registered: ${registered.map(item => item.agent).join(", ") || "none"} (agent settings and trust still apply; new sessions load adapters)`,
    `Not detected: ${absent.map(item => item.agent).join(", ") || "none"}; setup is available when their configuration directories appear`,
    `Process capture only: ${processOnly.map(item => item.agent).join(", ")}; use eventloom run <agent>`,
    ...registered.filter(item => item.changed && ["opencode", "pi"].includes(item.agent)).map(item => `${item.agent} adapter installed`),
    ...registered.filter(item => item.review).map(item => `Action: ${item.agent}: ${item.review}`),
    ...registered.filter(item => item.attention).map(item => `Action: ${item.agent}: ${item.attention}`),
    ...result.agents.filter(item => item.status === "error").map(item => `Error: ${item.agent}: ${item.detail}`),
  ];
}
