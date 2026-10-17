// Union of the installed Omarchy 4.0.0.alpha chooser and upstream quattro,
// verified 2026-10-16. A lazy launcher is never executed just to detect it.
export const AGENT_COMMANDS = Object.freeze({
  pi: "pi", omp: "omp", opencode: "opencode", ori: "ori", claude: "claude",
  codex: "codex", grok: "grok", openclaw: "openclaw", agy: "agy",
  hermes: "hermes", copilot: "copilot", crush: "crush",
  "cursor-agent": "cursor-agent", muse: "muse", kimi: "kimi", gemini: "gemini",
});

// These are adapter capabilities, not a claim that a local agent has loaded
// or trusted its hooks. Process capture is explicit via `eventloom run`.
const NATIVE = {
  claude: ["hooks", true, "sessions; tool completions and failures"],
  omp: ["extension", true, "sessions; turns; tools; approval requests and decisions"],
  codex: ["hooks", true, "sessions; subagents; local tools; approval requests; some outcomes unknown"],
  opencode: ["plugin", true, "sessions; turns; tools; approvals; experimental memory hook"],
  pi: ["extension", true, "sessions; turns; tools"],
  copilot: ["hooks", true, "sessions; turns; tools; no documented parallel call IDs"],
  gemini: ["hooks", true, "sessions; turns; tools; no documented parallel call IDs"],
  crush: ["partial hooks", false, "top-level tool starts only"],
  grok: ["hooks", false, "sessions; turns; tools; structured outcomes when available"],
  agy: ["hooks", true, "session starts; model invocations; tools; no session-end hook"],
  muse: ["hooks", true, "sessions; turns; tools; cleared hook environment"],
  "cursor-agent": ["partial hooks", false, "shell completions only; outcome unknown"],
};
export function agentCapabilities() {
  return Object.keys(AGENT_COMMANDS).map((agent) => {
    const [native = null, memory = false, notes = "native integration pending"] = NATIVE[agent] ?? [];
    return { agent, command: AGENT_COMMANDS[agent], process: true, native, automatic_memory: memory, notes };
  });
}
