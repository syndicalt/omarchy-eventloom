# omarchy-eventloom

Universal, local-first, append-only event log for every AI agent running on
Omarchy — powered by [@eventloom/runtime](https://github.com/syndicalt/eventloom).

One hash-chained JSONL shard per day, written by every agent (omp, Claude Code,
Codex, …), readable by every agent through the CLI or the eventloom MCP server.

```
~/.local/state/omarchy/agents/logs/2026-10-10.jsonl
```

## Why

Agents on the same machine work blind to each other. Omarchy stores each
agent's sessions in incompatible places and formats. omarchy-eventloom gives
all of them one append-only, tamper-evident record: what ran, which tools were
used, what needed approval, what completed or failed, and how sessions join
into a task (correlation IDs).

## Zero-touch install

```sh
git clone <this repo> ~/Projects/omarchy-eventloom
~/Projects/omarchy-eventloom/install.sh
```

Requirements: `bun` or `node >= 20`, plus `npm` (the installer pins
`@eventloom/runtime@1.0.0` under `~/.local/lib/eventloom` so bun and node seal
with the same build).

## Usage

```sh
eventloom append agent.note.added --actor omp --payload '{"text":"hello"}'
eventloom tail --limit 20 --actor omp
eventloom verify        # every daily shard; exit 2 on tamper
eventloom inspect       # adapter file present and actually wired
eventloom path          # today's shard path
```

Omarchy-style aliases: `omarchy-eventloom`, `omarchy-eventloom-inspect`.

## Event vocabulary

| Type | Meaning |
|---|---|
| `agent.session.started/resumed/completed/failed` | lifecycle |
| `agent.model.started/completed` | model switches |
| `agent.tool.started/completed/failed` | tool calls (inputs as key summaries) |
| `agent.approval.requested/resolved` | human-in-the-loop |
| `agent.file.mutated` / `agent.git.mutated` | filesystem / git side effects |
| `agent.handoff` | agent-to-agent or crash-diagnosis handoff |
| `agent.note.added` | free-form annotation |

Envelope is eventloom-strict; agent-specific detail lives in `payload`.
`correlation_id` joins events across agents working the same task.

## Adapters

Declared in `lib/adapters.json`; `eventloom inspect` reports what's installed.

- **omp** — `extensions/eventloom.ts`, installed to `~/.omp/agent/extensions/`
  when omp exists. Captures lifecycle, tools, approvals, model events.
- **claude** — `hooks/eventloom-hook.sh`, registered idempotently in
  `~/.claude/settings.json` (`SessionStart`, `Stop`, `PostToolUse`).

Community adapters: add a hook file, register a manifest entry with
`{"agent", "method", "hook_path", "events", "watch"}`, and the doctor picks it
up. Out-of-band capture (official hooks, reading the agent's own logs) is the
contract — no proxies.

## Privacy

- Redaction before sealing (the chain is irreversible). Recursive over nested
  values: assignment-shaped secrets (`access_token`, `client_secret`,
  `authorization: Bearer …`), PEM blocks, JWTs, and common GitHub, Slack,
  AWS, Google, npm, and `sk-`/`pk-` tokens. URL userinfo is stripped.
- `EVENTLOOM_MODE=full` (default) | `summary` (every string clipped to 200
  chars, including nested ones) | `metadata` (structure only, no content).
- `EVENTLOOM_DISABLE=1` opts any agent out.
- Shards are mode `0600` and the log directory is `0700`.
- Local-only by default. Logs are user-owned; `rm` the shard to purge.
  Shard names use the local calendar date, not UTC.

## Visualization

The **Tapestry** is a read-only, vertical session history: each session grows
upward from its start, widens and narrows with sampled activity, joins resumed
segments, and marks handoffs and completion. Start it with
`eventloom tapestry --days 7`; it serves locally at http://127.0.0.1:4747.
Use `eventloom tapestry --demo` for a representative in-memory weave without
reading or changing your logs.
The implemented projection is specified in
[`docs/tapestry-runtime.md`](docs/tapestry-runtime.md).

## Uninstall

```sh
~/Projects/omarchy-eventloom/uninstall.sh
```

Removes installed files and strips its hook entries from Claude settings;
leaves every other hook (herdr, etc.) untouched.

## Status

Prototype. `node --test` covers redaction, Claude settings edits, the tapestry
projection, and the Claude hook's failure mapping. Runtime chain locking and
tamper detection come from `@eventloom/runtime@1.0.0`.
Not yet: grok/codex/opencode adapters, Quickshell panel view.
