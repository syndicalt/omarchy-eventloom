# Agent coverage

The coverage target is the union of Omarchy's installed 4.0.0.alpha chooser
and upstream quattro, verified on 2026-10-16: 16 agent commands. The upstream
[chooser](https://github.com/omacom/omarchy/blob/quattro/bin/omarchy-default-agent)
adds Ori, Antigravity and Kimi; the installed chooser also includes Gemini.
`eventloom agents --json` reports bundled capabilities. `eventloom doctor`
checks local wiring; it cannot prove that an agent has loaded or trusted a hook.

## Common process capture

`eventloom run <agent> [-- <arguments>...]` supports pi, omp, opencode, ori,
claude, codex, grok, openclaw, agy, hermes, copilot, crush, cursor-agent, muse,
kimi and gemini. It invokes that command through PATH, with inherited terminal
streams and the current directory. Running an Omarchy lazy launcher explicitly
can trigger that launcher's normal installer. Inventory and Eventloom's
installer never execute agent launchers to detect them.

The wrapper records `agent.process.started` and `completed` or `failed`,
with a fresh process ID, source `process`, exit code and duration. It forwards
SIGINT, SIGTERM and SIGHUP, preserves the child's exit status, and uses 127
for a launch failure. Logging failures remain private and do not prevent
the agent from running. Arguments, prompts and terminal streams are not
captured. These are process boundaries, not inferred native sessions.

A correlation ID is passed to native adapters through the environment, so
their logical sessions can be related to the process. The wrapper also
provides attribution for explicit `eventloom note` calls made inside an agent.
Agents that clear the environment can lose that link. Wrapping a background
client such as `openclaw tui` tracks the client process, not remote gateway
activity. There is no process-level automatic memory injection.

## Native installation

Existing user hooks, plugins and unrelated settings are preserved. JSON
configuration edits are atomic, retain symlinks and modes, and leave an
`.eventloom-backup`. Invalid JSON and JSONC are refused without modification.
The shared shell wrapper stays behind after an unsuccessful unregistration;
it returns a neutral response even after the Eventloom CLI has been removed.
`eventloom agents setup` registers bundled adapters for agents whose
configuration directories exist. The installer runs it and prints a summary;
the running Omarchy plugin also runs it once a minute, so an agent configured
later does not require reinstalling Eventloom. It never launches an agent or
runs a package manager. A new agent session loads its adapter. The background
check uses the shell environment; run the command in your terminal to use
custom directory environment variables. Disabled flags, matchers, handler
options and unrelated hooks are retained. Malformed settings are reported and
left unchanged while other agents continue. Registration does not grant Codex
hook trust: review `/hooks` if the definitions have not already been trusted.


| Agent | Native registration | Captured events and limits |
|---|---|---|
| Claude Code | `~/.claude/settings.json` and `hooks/eventloom-hook.sh` | Sessions, completed and failed tools. Other harnesses' recognizable compatibility payloads are ignored. |
| omp | `~/.omp/agent/extensions/eventloom.ts` | Sessions, turns, tools, approval requests and resolutions. Parallel tools use call IDs. |
| Codex | `$CODEX_HOME/hooks.json`, default `~/.codex/hooks.json` | Sessions, local tool starts/results, approval requests and child-session boundaries. Review hooks in Codex `/hooks`; trust and config.toml are not edited. Hosted tools are not covered. Shell stdout alone cannot establish success. |
| OpenCode | `$XDG_CONFIG_HOME/opencode/plugins/omarchy-eventloom.js`, default `~/.config/opencode/plugins/` | Sessions, turns, tool outcomes/call IDs and approvals. Idle completes a turn, not a session. Global plugins also load alongside `OPENCODE_CONFIG_DIR`. |
| Pi | `$PI_CODING_AGENT_DIR/extensions/omarchy-eventloom.js`, default `~/.pi/agent/extensions/` | Sessions, turns, tool outcomes/call IDs and model errors. Session replacement uses shutdown/start rather than omp's switch API. |
| Copilot CLI | `$COPILOT_HOME/hooks/omarchy-eventloom.json`, default `~/.copilot/hooks/` | Sessions, turns, tool starts, successful results and failures. PascalCase registration selects snake_case payloads. No documented parallel call IDs; repeated same-name calls pair in arrival order. |
| Gemini CLI | `~/.gemini/settings.json` | Sessions, turns and tools. AfterTool's optional structured error establishes failure; tool contents are discarded. No documented parallel call IDs. |
| Crush | `$XDG_CONFIG_HOME/crush/crush.json`, default `~/.config/crush/crush.json` | Top-level tool starts only. Its current API exposes no session or completion events and excludes child tools. Project hook precedence can limit global hooks. |
| Grok | `$GROK_HOME/hooks/omarchy-eventloom.json`, default `~/.grok/hooks/` | Sessions, turns and tools. Uses Grok's camelCase input, call IDs and turn IDs. Explicit structured exit/error fields establish outcomes; opaque results stay unknown. Compatibility copies of the Claude observer are ignored. |
| Antigravity | `~/.gemini/config/hooks.json`, under the named `omarchy-eventloom` hook | Session starts, model invocations and tools. Conversation IDs and toolCall objects differ from Gemini. No documented session-end hook. Step indices are not assumed to be stable tool-call IDs. |
| Muse | `$XDG_CONFIG_HOME/muse/settings.json`, default `~/.config/muse/settings.json` | Sessions, turns and tools, including parallel call IDs. Requires the current settings hook API (documented for 1.3.0). Muse clears most environment variables, including Eventloom overrides; use Muse's hook settings to disable capture. |
| Cursor CLI | `~/.cursor/hooks.json` | Shell completions through afterShellExecution. The editor exposes a larger API; this adapter claims only the CLI's shared shell surface. No structured exit status or reliable parallel call ID, so outcome stays unknown. |

Copilot, Gemini, Crush, Grok, Antigravity, Muse and Cursor use the shared script
`~/.local/share/eventloom/hooks/eventloom-native-hook.sh`. Their payload
conversion and configuration formats remain distinct in `lib/native-hooks.mjs`.
The script buffers stdout and returns a valid neutral object if recording
fails. Antigravity's PreToolUse requires a decision: its documented `allow`
delegates to remaining hooks and default policy; Eventloom never returns
`auto_approve`, argument rewrites or permission overrides.

## Memory and capture limits

Memory defaults off. When enabled, Claude, omp, Codex, OpenCode, Pi, Copilot,
Gemini, Antigravity and Muse can receive a project briefing. Each adapter uses
its native context-injection mechanism. Note commands carry explicit session
attribution where the harness does not reliably export a session variable.
OpenCode's system transform is experimental. Grok ignores SessionStart stdout,
Crush lacks a session hook, and Cursor's CLI coverage here has no context
injection; those agents retain manual recall and notes. Metadata capture mode
does not inject or retain memory summaries.

Native observers discard prompts, transcript paths, argument values, tool
results, replies and error text. They retain structural metadata such as tool
names, argument key names, IDs, durations and explicit outcomes. Session ends
are best effort and may be lost if the agent kills its shutdown hooks. Native
pre-tool observations do not prove that execution subsequently occurred.
Stop hooks can repeat when another hook requests continuation, so turn-end
observations do not establish an exact count of provider API calls.

## Remaining native integrations

These agents have explicit process capture today; their native integrations
are not bundled or claimed complete:

- **Hermes:** its Python plugins and shell hooks cover CLI and gateway events.
  Gateway-only HOOK.yaml handlers do not capture CLI tools. Its canonical
  on_session_end fires at turn finalization, so it cannot be mapped directly
  to a conversation ending. Plugin activation and per-profile configuration
  need a dedicated implementation.
- **OpenClaw:** typed plugin hooks expose session, tool and prompt lifecycle
  events. A native plugin needs a manifest, activation and policy-aware
  registration, and must run in the gateway to observe gateway work.
- **Kimi:** native hooks live in a TOML array in `~/.kimi-code/config.toml`.
  Safe reversible TOML registration and permission-result handling are pending.
- **Ori:** delegated `ori claude`, `ori codex`, `ori opencode`, etc. can use the
  corresponding harness adapter when it loads the registered user config.
  Ori's own `ori code` harness currently has process capture only. It is not
  relabeled as another harness merely because it uses the same model.

## Validation and sources

Codex CLI 0.163.0 passed a native smoke check with a disposable HOME and
CODEX_HOME and a loopback mock Responses server: session boundaries, local
shell calls, opt-in briefing injection, chain verification and privacy.
`npm run check:codex` repeats it without model charges or live account calls.
OpenCode plugin/SDK 1.19.3 and Pi extension API 0.73.1 supplied the published
contracts for their tests. Claude Code 2.1.302 also passed a native loopback Messages check covering
successful and failed tools, lifecycle, opted-in memory and privacy. Run
`npm run check:claude` to repeat it. omp 18.8.6 passed the same native
fixture with its real extension, including tool IDs; repeat with
`npm run check:omp`. Other new adapters use the references below and
real installer/wrapper tests with fixture payloads. They have not all been
validated inside live agent sessions; older binaries may lack newer hooks.
The full check exercises all 16 process commands using local disposable
executables, including signals, exit codes, opt-out and output privacy.

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Gemini hooks](https://geminicli.com/docs/hooks/reference/)
- [Crush hooks](https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md)
- [Grok hooks](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md)
- [Antigravity hooks](https://antigravity.google/docs/hooks)
- [Muse hook payloads](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/reference/hook-events/)
- [Cursor hooks](https://cursor.com/docs/hooks) and [CLI hook scope clarification](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316/7)
- [Hermes hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- [OpenClaw plugin hooks](https://docs.openclaw.ai/plugins/hooks/reference)
- [Kimi hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)
- [Ori harnesses](https://openrouter.ai/ori/harness/opencode)
