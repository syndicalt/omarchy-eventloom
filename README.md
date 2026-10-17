# omarchy-eventloom

One local log of what the AI agents on your machine did.

Eventloom is an Omarchy plugin that records agent activity in a single
append-only file per day: session lifecycles, tool calls and the approval
events and outcomes each adapter can observe. Beside that it keeps a
memory, if you turn it on: short summaries the agents write of their own
replies, filed by project and handed to the next session that opens there,
when that agent supports automatic memory. Twelve agents have native adapters,
with the event coverage listed below. `eventloom run <agent>` adds process
start and exit capture for the sixteen commands in the dated coverage matrix
below. Eventloom does not upload the log. Payloads pass through best-effort
redaction before being written to a SHA-256 hash chain. The chain detects
inconsistent edits; by itself it cannot detect a fully recomputed history or
a truncated newest tail. Optional sealed mode records protected checkpoints
of that history. See [Integrity](#integrity) for the limits.

```
$ eventloom tail --limit 4
{"ts":"2026-10-12T14:02:11.482Z","type":"agent.session.started","actor":"claude","thread":"claude-0b9a…","payload":{"cwd":"/home/me/app","git_branch":"main","git_dirty":true,…}}
{"ts":"2026-10-12T14:02:19.007Z","type":"agent.tool.completed","actor":"claude","thread":"claude-0b9a…","payload":{"tool":"Bash","tool_input_keys":["command","description"],…}}
{"ts":"2026-10-12T14:02:24.650Z","type":"agent.tool.failed","actor":"omp","thread":"omp-01a1…","payload":{"tool":"read","duration_ms":12,…}}
{"ts":"2026-10-12T14:03:40.118Z","type":"agent.session.completed","actor":"claude","thread":"claude-0b9a…","payload":{"reason":"prompt_input_exit",…}}
```

![The Tapestry: a day of agent sessions woven as bands, one stitched design per action](preview.jpg)

*Demo data showing session bands, shared-memory connections, stitch detail and replay controls.*

*Each band shows a recorded session or wrapper process growing upward from
its start; stitched designs represent recorded events.*

## Why

When work spans multiple agents or sessions, three questions come up:

- **What happened while I was not watching?** Each agent keeps its own
  transcript in its own place and format. Eventloom combines the events its
  adapters observe, so you can follow activity across agents and projects.
- **Can I trust the record?** A transcript the agent itself can rewrite is not
  independent evidence of what it did. Eventloom records observations through
  native hooks and extensions, hash-chains them, and links daily shards.
  `eventloom verify` checks consistency and, with sealed mode enabled, protected
  checkpoints. Neither mode proves that an agent reported events truthfully.
  See [Integrity](#integrity).
- **How do agents find out about each other?** A shared log gives agents and
  their owner a common record to read: `eventloom tail`
  from a script, a hook or another agent, and a `correlation_id` that ties the
  sessions of different agents to the same task.

It is mostly a record of *what happened*, not *what was said*. Of an agent's
work the bundled adapters retain selected metadata, including tool names,
argument key names, paths, identifiers and outcomes. They discard argument
values, tool output and prompts. Automatic memory, when enabled and supported,
asks agents to write short reply summaries. Explicit `eventloom note` calls
can also record summaries while automatic memory is off. See
[Memory](#memory) and [Privacy](#privacy).

## How it works

```
 native hooks / extensions ─┐
 eventloom run <agent> ─────┼─► eventloom CLI ─► redact ─► daily JSONL hash chain
 append / ingest ──────────┘                                      │
                                     tail · verify · doctor · tapestry
                                                                 │
                                  optional seal file (checkpoint hashes)
```

- **Adapters** use agent hooks, plugins and extension APIs. Extensions run
  inside their host agent; command hooks run as child processes. These are
  observers, not an independent security boundary. When memory is enabled,
  supported adapters add a project briefing. Command hooks may also return
  neutral protocol responses. Recording errors are caught where possible
  and reported privately; queued events can be lost on termination.
- **The CLI** writes events for the bundled adapters. It adds available
  session provenance (host, Omarchy release, git branch and commit), redacts,
  and hands the event to
  [@eventloom/runtime](https://github.com/syndicalt/eventloom), which seals it
  into the day's chain.
- **Readers** are plain commands over plain JSONL, plus the Tapestry, a local
  page that weaves the log into a picture.

## Install

As an Omarchy plugin:

```sh
omarchy plugin add https://github.com/syndicalt/omarchy-eventloom.git --enable
```

Adding only clones the repository. Enabling starts a small background service
(no bar icon, no window) which, a few seconds later, installs everything:

- the `eventloom` CLI into `~/.local/bin`, and its code into
  `~/.local/lib/eventloom` with its two direct dependencies, `@eventloom/runtime`
  and `three` (for the Tapestry), exactly as `package-lock.json` pins them
  (dependency installation uses the network);
- the omp extension, when `~/.omp/agent` exists;
- the Claude Code hooks, when `~/.claude` exists. `~/.claude/settings.json`
  is edited in place: other hooks are kept, the previous contents are saved
  beside it as `settings.json.eventloom-backup`, and a file that cannot be
  parsed is left alone.
- the Codex hooks, if its configuration directory is present. Registration
  updates `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`), preserves other
  hooks, and backs up changed contents. `config.toml` and hook-trust records
  are untouched. **Review and trust Eventloom's hooks in Codex `/hooks`**;
  registration alone does not allow them to run.
- the OpenCode plugin, if its configuration directory is present. It is a
  local JavaScript file in `~/.config/opencode/plugins/` (under
  `$XDG_CONFIG_HOME` when set); `opencode.json` and other plugins are kept.
  It also covers an `OPENCODE_CONFIG_DIR` used alongside global config.
- the Pi extension in `~/.pi/agent/extensions/` (or `$PI_CODING_AGENT_DIR`),
  when that directory exists; other extensions and settings are preserved.
- native command hooks for Copilot CLI, Gemini CLI, Crush, Grok, Antigravity,
  Muse and Cursor CLI, when their configuration directories exist. Each uses
  its own native format. JSON settings are backed up before changes, and
  malformed files (including JSON with comments) are left unchanged.
  No agent launcher is run to detect an installation. See the
  [coverage and configuration reference](docs/agent-coverage.md).

Agent setup is automatic: the installer prints registered agents, agents not
detected, process-only coverage, and any actions such as Codex hook trust.
When the plugin is running, it checks for newly created agent configuration
directories once a minute and registers missing adapters without downloads or
launching agents. Start a new agent session to load an added adapter. For an
immediate check, or a custom agent directory supplied through environment
variables, run:

```sh
eventloom agents setup
eventloom agents setup --json
```

Repeat runs leave unchanged files alone. Existing disabled hooks, matchers and
handler options are preserved; restrictions and configuration errors are
reported for you to resolve. Agent settings and hook trust still determine
whether a registered adapter runs. The background check uses the shell
service's environment; use the command from your terminal for overrides such
as `CODEX_HOME`, `OPENCODE_CONFIG_DIR` or `PI_CODING_AGENT_DIR`.

Run in a terminal, `install.sh` asks for the Tapestry's port, offers shared
memory if it is off, then offers [sealed mode](#sealed-mode) if it is off.
For sealed mode it prints a `sudo` command and runs nothing. Installed
through the plugin there is no terminal, so it asks nothing and preserves
existing settings. A fresh installation defaults to port 4747 and memory off;
sealed mode requires separate manual setup. Change them with
`eventloom config set tapestry_port <n>`, `eventloom config set memory on`,
and `eventloom seal enable`.

It finishes by running `eventloom doctor`, and it runs again by itself after
`omarchy plugin update`, normally within one minute. The service checks the
checkout revision without running the installer when it is already current.
The service is kept loaded across plugin rescans: restart the shell once to
load a changed service implementation. Later agent discovery and CLI updates
then happen without restarting the shell.
A failed revision is tried once; a new revision or
`omarchy-shell eventloom install` retries it. If it cannot finish you get one notification saying
so; the reason is in `omarchy-shell eventloom status`, and running
`install.sh` in a terminal shows it in full. Notifications never quote what
went wrong, because the text of a notification can be read by other users of
the machine while it is being sent. Requires `bun`, or `node >= 20` with
`npm`.

The service answers on the shell's IPC:

```sh
omarchy-shell eventloom status     # {"state":"ready", …}
omarchy-shell eventloom doctor     # run the health check; notifies healthy, or how many problems
omarchy-shell eventloom tapestry   # open the Tapestry in the browser
omarchy-shell eventloom install    # run the installer again now
```

Without the plugin system, clone the repository anywhere and run
`./install.sh`; run it again to upgrade.

## Usage

```sh
eventloom append agent.note.added --actor me --payload '{"text":"hello"}'
eventloom tail --limit 20 --actor omp   # newest events, across shards
eventloom verify                        # every shard and the links between them; exit 2 on failure
eventloom doctor                        # log health and adapter wiring
eventloom recover                       # set a damaged shard aside, keep its verified prefix
eventloom purge 2026-10-10              # delete one day's shard and record that it was
eventloom path                          # today's shard
eventloom config set tapestry_port 5000 # remember a setting (eventloom config lists them)
eventloom seal status                   # sealed mode: on or off, and how far the log is sealed
```

`omarchy-eventloom` and `omarchy-eventloom-inspect` are aliases for
`eventloom` and `eventloom doctor`.

## Memory

A list of tool calls says that something happened, not what it was for. So
agents can be asked to say: after a reply that changed, decided or found
something, the agent records one to three sentences about it.

Memory is off until you turn it on, because it changes what your agents are
told: supported native adapters can add instructions and summaries from
earlier sessions. Process capture alone does not add a briefing. `install.sh` asks when it runs in a terminal; otherwise:

```sh
eventloom config set memory on    # or off; eventloom doctor shows which
```

```sh
eventloom note --tags release <<'EOF'
Ran the migration dry run and added the health check to rollback. Tests pass.
EOF

eventloom recall                 # what was recorded for this project (git repository, or directory)
eventloom recall --tag release   # narrowed by tag; also --correlation <id>, --all, --limit, --days, --json
```

`recall` defaults to at most eight summaries from the thirty most recent
daily shard files. `--days N` currently limits shard files, not elapsed calendar
days; `--days all` searches every retained shard.

- **Written by the agent or owner.** With memory on, a supported adapter
  tells the agent how to record a summary and supplies the project's first
  summary, however old, plus up to eight latest summaries from the thirty
  most recent daily shards. The first is not repeated if already included.
  Claude Code and Codex receive this through SessionStart hooks; omp and Pi
  receive it before an agent turn, and other supported adapters use their
  native context hooks. OpenCode's hook is experimental. Compaction or session
  changes can trigger another briefing. Codex briefings include explicit actor
  and session arguments for the note command so its notes are attributed
  even without an agent session environment variable. Whether an agent writes
  a summary is up to it; some replies go unrecorded. The owner can also call
  `eventloom note` directly, regardless of the memory setting.
- **Shared across agents.** A summary belongs to a project, not to the agent
  that wrote it, so omp starts from what Claude left and the reverse.
- **Attributed recall is recorded too.** When nonempty summaries are supplied
  to an identified agent session, an `agent.memory.recalled` event names them.
  Manual recall outside an attributed session does not emit this event.
  The Tapestry links recorded recalls to their source summaries.
  This records that context was supplied, not that the agent read or used it.
- **Bounded.** A summary is at most 600 characters; longer text is refused. It is read from standard input, never from the
  command line, and is redacted like everything else.
- **Your choice.** With memory off, sessions are neither briefed nor asked
  for summaries; `eventloom note` and `recall` still work when you use them
  yourself. `EVENTLOOM_MEMORY=1` or `0` overrides the setting for one
  process. `EVENTLOOM_MODE=metadata` drops summary text and suppresses
  automatic briefings. Recall can still read summaries already stored.

## Events

| Type | Meaning | Emitted by |
|---|---|---|
| `agent.process.started` / `completed` / `failed` | process boundaries, exit code and duration | `eventloom run`, all Omarchy agents |
| `agent.session.started` / `resumed` / `completed` | native session lifecycle, where exposed | see adapter matrix below |
| `agent.model.started` / `completed` / `failed` | turns or model invocations, depending on adapter | omp, Pi, OpenCode, Copilot, Gemini, Grok, Antigravity, Muse |
| `agent.tool.started` / `completed` / `failed` | tool observations; inputs as argument names only | native adapters, subject to limits below |
| `agent.approval.requested` / `resolved` | observed approval requests and decisions | omp and OpenCode; Codex requests only |
| `agent.note.added` | free-form annotation | `eventloom append` |
| `agent.reply.summarized` | an agent's summary of its reply, with `project` and `tags` | `eventloom note` |
| `agent.memory.recalled` | nonempty summaries supplied to an identified session, by id | attributed recall and supported briefings |
| `eventloom.shard.anchored` | opens a shard; links it to the previous one | the store |
| `eventloom.shard.acknowledged` | a shard was recovered or purged on purpose | `recover`, `purge` |

A pre-tool observation records a requested call, not proof it executed.
Model events describe harness turns or model-hook callbacks; they are not a
provider request count or a measure of token usage.

The tapestry also recognises `agent.session.failed`, `agent.handoff`,
`agent.file.mutated` and `agent.git.mutated`; no bundled adapter emits them
yet. Any well-formed type is accepted and stored, except the `eventloom.*`
types, which only eventloom itself writes.

Adapter payloads carry `session_id`, `correlation_id` and `occurred_at`.
`occurred_at` is the adapter's observation time, or an agent-provided time
where available; the envelope `timestamp` is assigned when the event is
created for append. Neither is the protected seal helper's timestamp. Set `EVENTLOOM_CORRELATION_ID` in an agent's environment to join
its sessions to a task shared with other agents; otherwise each session
correlates only with itself, and Codex subagents share their parent's
correlation.

## Adapters

- **omp** — `extensions/eventloom.ts`, copied to `~/.omp/agent/extensions/`.
  Queues events in memory and writes them in order through one
  `eventloom ingest` process at a time. At shutdown whatever is still queued
  goes to a second process at once, rather than waiting for the queue to drain;
  those last events can be sealed out of order, and `occurred_at` gives the
  adapter's observation time. The one wait is the briefing before a session's first turn,
  which is given two seconds and then abandoned. The CLI returns no briefing
  when memory is off; `EVENTLOOM_MEMORY=0` skips the briefing request entirely.
- **claude** — `hooks/eventloom-hook.sh`, registered in
  `~/.claude/settings.json` for `SessionStart`, `SessionEnd`, `PostToolUse` and
  `PostToolUseFailure`. `settings.json` is never rewritten if it cannot be
  parsed, other hooks are left in place, and the previous contents are kept
  as `settings.json.eventloom-backup`.
- **codex** — `hooks/eventloom-codex-hook.sh`, registered in
  `$CODEX_HOME/hooks.json` (normally `~/.codex/hooks.json`) for `SessionStart`,
  `SessionEnd`, `PreToolUse`, `PostToolUse`, `PermissionRequest`,
  `SubagentStart`, and `SubagentStop`. Subagents have their own session bands
  with a link to their parent. Supplied tool-call IDs distinguish parallel
  calls. The observer returns no permission decisions or argument rewrites;
  recording failures go to the private error log and its wrapper exits
  successfully. Foreground hook execution can still add latency.

  Tested against **Codex CLI 0.163.0**. Hosted tools such as web search do not
  pass through tool hooks. `PermissionRequest` exposes the request, not the
  eventual decision. Tool outcomes are recorded only when the result has
  explicit structured status fields; Codex shell hooks supplied just
  stdout in the tested 0.163.0 fixture, so those outcomes are marked
  **unknown**, including nonzero exits.
  The end of a reply is not treated as a session ending. Memory is still
  opt-in, and transcripts, prompts, argument values and output are never
  stored. `doctor` checks registration; Codex's `/hooks` controls trust.
  See the [official hook reference](https://learn.chatgpt.com/docs/hooks).

- **opencode** — `extensions/opencode.js`, copied to
  `~/.config/opencode/plugins/omarchy-eventloom.js`. A local plugin loads the
  installed adapter without adding an npm dependency or editing OpenCode's
  configuration. Sessions, turns, tool starts and outcomes, and permission
  requests and decisions are recorded. An idle session stays open; deletion
  or orderly server disposal closes it. Abrupt termination can lose the final
  queued events. Tool snapshots are deduplicated by session and call ID.
  Only argument names and structured status are retained; titles, prompts,
  output, errors and permission patterns are discarded. Shared memory is
  opt-in and uses the experimental system-context hook, with one recall per
  session or compaction and explicit note attribution.

  Tested against published plugin/SDK **1.19.3** contracts and the installed
  loader in a disposable home. A native OpenCode run has not yet been tested
  on this machine; its command is still a lazy launcher. See the
  [plugin reference](https://opencode.ai/docs/plugins/).

### Omarchy agent coverage

The target is every agent in Omarchy's default-agent chooser. This matrix
tracks the installed **4.0.0.alpha** chooser and upstream **quattro**, checked
on **2026-10-17**. The [upstream chooser](https://github.com/omacom/omarchy/blob/quattro/bin/omarchy-default-agent)
adds Ori, Antigravity and Kimi; the installed chooser still offers Gemini.
Upstream also accepts `gemini` as an alias for Antigravity. The matrix covers
the union of these choosers, not a claim that all commands are installed.
Every row supports explicit process capture through `eventloom run`. Native
adapters can load on a new ordinary launch after registration, subject to
agent versions, configuration, hook policy and any required trust review. Process capture alone does not observe tools, approvals or
logical session boundaries. `eventloom agents` prints this inventory;
`eventloom agents --json` exposes it to scripts.

| Agent | Bundled capture | Automatic memory | Coverage notes |
|---|---|---|---|
| Claude Code | Native hooks | Opt-in | Sessions and completed/failed tools; no tool-start hook registered |
| Oh My Pi | Native extension | Opt-in | Sessions, turns, tools, approval requests and decisions |
| Codex | Native hooks | Opt-in | Sessions, subagents, local tools, approval requests; outcome and hosted-tool limits above |
| OpenCode | Native plugin | Opt-in | SDK/plugin 1.19.3 contracts tested; native CLI validation pending |
| Pi | Native extension | Opt-in | Separate Pi lifecycle; extension contract 0.73.1 tested |
| Copilot CLI | Native hooks | Opt-in | Sessions, turns and tools; no documented parallel call IDs |
| Crush | Partial native hooks | Manual | Top-level tool starts only; no completion or lifecycle hook |
| Grok | Native hooks | Manual | Sessions, turns and tools; SessionStart stdout is ignored |
| OpenClaw | Process capture | Manual | Native plugin integration pending |
| Hermes | Process capture | Manual | Native CLI/gateway plugin integration pending |
| Cursor CLI | Partial native hooks | Manual | Shell completions only; result status unknown |
| Muse | Native hooks | Opt-in | Sessions, turns and tools; hook environment is cleared by Muse |
| Ori | Process capture | Manual | Delegated agents can use their native adapters; `ori code` has process coverage |
| Antigravity | Native hooks | Opt-in | Session starts, model invocations and tools; no session-end hook |
| Kimi | Process capture | Manual | Native TOML-hook integration pending |
| Gemini CLI | Native hooks | Opt-in | Sessions, turns and tools; no documented parallel call IDs |

For example:

```sh
eventloom run codex
eventloom run codex -- --help
eventloom run hermes
eventloom run ori -- code
eventloom run kimi
```

Arguments and terminal streams pass directly to the agent and are not
recorded. Its exit status is preserved. A wrapper process and a native
session have different IDs, joined by a correlation ID when the native
agent passes through the environment. Process capture supplies no automatic
memory briefing; `eventloom recall` and `eventloom note` remain available.
`EVENTLOOM_DISABLE=1 eventloom run …` still launches the agent, without
recording the process.

A new adapter must preserve other user configuration, uninstall cleanly,
pass recording failures through without disrupting the agent, honor capture
mode and memory opt-in, and document unsupported events. A registered hook
is not proof that an agent has enabled or trusted it.

To add an adapter: capture the agent's events out of band (its hooks or
extension API, not a proxy), pipe them to `eventloom ingest` as one
`{"type","actor","thread","payload"}` object per line, and add an entry to
`lib/adapters.json` so `eventloom doctor` checks it.

Adapters do not add conversational messages except opted-in briefings.
Command hooks still return protocol output where required, such as Codex's
empty JSON response. Recording diagnostics go to
`~/.local/state/omarchy/agents/eventloom-errors.log`; `eventloom doctor`
reports recent errors. This file is separate from the hash-chained log.

## Privacy

- Bundled native observers select metadata rather than retain full hook
  inputs: tool names, argument key names, IDs, paths, durations and available
  outcomes. They discard prompts, transcripts, argument values and tool
  output. Paths, names and identifiers can still reveal project information.
  Explicit `eventloom note`, `append` and `ingest` calls can record content;
  the memory setting controls automatic briefing, not permission to write a
  summary. Diagnostic error text is kept in a separate redacted error log.
- A summary is content. It is redacted like any other text, which is best
  effort (below), it is shown in the Tapestry, and it is given to later
  sessions in the same project. A briefing becomes part of the agent's context;
  an agent using a remote model can send it to that provider. Memory is off
  unless you turn it on.
- Payloads pass through redaction before hashing. Editing stored text later
  would invalidate its chain; redaction is not a way to remove secrets from
  existing events. In a structured payload, every string or number under
  a secret-named key (`password`, `*_token`, `*_API_KEY`,
  `aws_secret_access_key`, `authorization`, `cookie`, their plurals, …) is
  replaced, however deeply nested. `tokens` is the exception: it is treated
  as a count (`max_tokens`).
- In free text it is pattern matching, and best effort. Recognised:
  - a secret-named `NAME=value`, `NAME: value`, `NAME := value`,
    `'NAME' => value`, `config["NAME"] = value`, quoted or not, including
    inside JSON carried as a string (in `NAME: type = value` the type is
    redacted along with the value);
  - `Authorization` values (the scheme is kept), `Cookie` header lines, and
    URL userinfo;
  - `--password x` style flags, `curl -u user:pass` and
    `docker|podman|helm|oc|az login -p x`, also when the command or one of
    its quoted arguments runs over several lines;
  - PEM blocks, JWTs, and GitHub, Slack, AWS key id, Google, npm, Stripe and
    `sk-`/`pk-` tokens.
- Where it has to guess it redacts, so text after `password:` goes even if
  it was not a password, and after a `curl` the value following a later,
  unrelated `-u` may go too. A command is followed to the end of its line,
  over continuation lines, and for up to 4,000 characters while one of its
  quoted arguments is still open; a flag further on than that is missed. In
  text carried as JSON, where a whole script is one line, it is followed to
  the end of the string. A quoted value that runs over several lines is
  redacted to the end of its first. Not caught: a value spliced from several
  quoted pieces in shell (`'a'"'"'b'`), a bare high-entropy string with no
  telling name or shape, a quoted value that begins with punctuation when it
  is glued to a short flag with its quote backslash-escaped (`-p\":…\"`) or
  follows an unbalanced quote of the same kind earlier on the line, a name that
  goes on after the secret word other
  than `_confirmation`, `_base` or a digit (`password_hint`), a value
  computed by an expression
  (`os.getenv("PW") or "…"`), a command printed as a list of arguments
  (`['curl', '-u', 'user:pass']`), a token used as a URL's user with no
  password (`https://TOKEN@host`), other short flags, and secrets named in a
  language other than English. If free text may carry secrets you cannot name, use
  `EVENTLOOM_MODE=metadata`.
- `EVENTLOOM_MODE=full` (default) keeps the redacted payload; it does not
  enable full transcript capture in bundled adapters. `summary` truncates
  payload strings after 200 characters and adds an ellipsis; it does not
  generate summaries. `metadata` keeps only allowed scalar fields, dropping
  summary text but retaining fields such as paths, host, IDs and tool names.
  It is not anonymization.
- `EVENTLOOM_DISABLE=1` disables bundled observation when the agent passes
  it through. It does not disable explicit `append` or `note` commands.
  Muse clears this override; use its native hook controls there.
- `eventloom append --payload '…'` puts the payload on a command line, which
  other users of the machine can read in the process list while it runs. The
  bundled adapters pass events on standard input instead (`eventloom ingest`).
- The installer restricts the default log directory to `0700` and its JSONL
  shards to `0600`; new shards are also created with mode `0600`. Custom or
  manually changed directory permissions should be checked with `doctor`.
  Eventloom does not upload logs, but programs running as you and root can
  read them. `eventloom purge <day>` deletes a day, with any copies `recover`
  set aside for it, and records that it did, so `verify` reports the gap as
  acknowledged and not as tampering.

## Integrity

Each shard is a SHA-256 hash chain, and each new shard opens with an anchor
holding the previous shard's name and the hash and position of its last event
at that moment. `eventloom verify` detects inconsistent edits and reordering
within retained chains, and missing or shortened shards referenced by a later
anchor. Gaps left
by `eventloom recover` and `eventloom purge` are recorded in the log and
reported as warnings; anything that changes after such a record is an error
again.

On its own that is tamper-evident against accident and casual edits, and no
more. The head of the chain is the last line of today's shard, and nothing
outside the log holds it: a process running as you, an agent included, can
cut events off the end, or rewrite the log and recompute every hash, and
`verify` will pass.

### Sealed mode

Sealed mode adds protected checkpoints for recorded history on this machine.
It is off until you perform the manual privileged setup.

```sh
eventloom seal enable    # prints the one sudo command; eventloom never runs it
eventloom seal status    # on or off, how many events are not yet sealed
eventloom seal now       # seal the log's head immediately
```

- The setup creates a system user, `eventloom-seal`, and a seal file that
  only that user can write: `/var/lib/eventloom-seal/<uid>.evtseal`. You can
  read it; neither you nor an agent running as you can change or delete it.
- Eventloom asks a root-installed helper to append as `eventloom-seal`,
  through a sudoers rule restricted to that helper. Each record is the
  day, the count of events and the hash of the last one, stamped with the
  helper's own clock. No log content.
- Eventloom attempts a seal at native session boundaries and when at least
  10 events have accumulated since the last checkpoint. This is an interval
  for attempts, not a guaranteed bound on the unsealed tail: pending or
  failed attempts can leave more events unsealed. `doctor` and `seal status`
  report the current state.
- `eventloom verify` then also fails if the log does not hold, at each sealed
  position, the sealed hash. That catches truncation past a protected
  checkpoint, a rewrite that changes its hash even with a consistent new
  chain, and deletion of a shard that still has protected checkpoints.
- `purge` and `recover` still work, and write a record in the seal file that
  cannot be removed. The gap is reported by `verify` from then on.
- There is no ordinary on/off setting: sealed mode applies when the seal
  file exists and names the current log directory. `EVENTLOOM_LOG_DIR` can
  redirect future writes to a different, unsealed directory; it does not
  remove protected records of the original log. An agent can also stop
  sealing or modify the user-owned client, so the seal is a checkpoint of
  recorded history, not a guarantee of continued observation.

What sealed mode does not do:

- It does not make events true. An agent can still append false events, or
  events under another agent's name; a seal says what the log held at a time.
- It does not cover the events written since the last seal.
- It does not hold against root, which can rewrite the seal file too. Only a
  witness off the machine answers that.
- It does not protect the program that checks it. `eventloom` is installed in
  your home directory, where an agent can change it, so an agent that wants
  to hide tampering can also make `verify` lie. The seal file itself stays
  honest: it is plain text, and the hash on any `head` line can be compared
  by hand with the `hash` of that event in the day's shard.

Either way, treat what agents read from the log as untrusted input.

The design, and why each part is there, is in
[`docs/sealed-mode.md`](docs/sealed-mode.md).

## Visualization

The **Tapestry** is a read-only view of the log as needlework, rendered with
three.js: evenweave linen on a rod, recorded activity embroidered as counted
designs, each session or process a band growing upward from its start, and
handoffs, forks, resumes and shared goals strung between designs as plied
yarn. New activity is stitched in as it arrives. Paired tool start/completion
events share a design; internal shard anchors are omitted.

The cloth opens close enough to read the designs. Drag to pan, scroll to
zoom, or use **Frame the cloth** (`F`) to see the whole piece. Click a stitch
for its details and a live magnified view of its embroidery. **Trace
connections** follows its yarn to related sessions; the agent colors in the
playback bar highlight one agent's work.

Use the bottom bar to replay the selected log range, pause, scrub in either
direction, and change speed. **Live** returns to new arrivals; **Follow
live** keeps new work in view until you pan or zoom. Playback changes only
the view. With reduced motion enabled, live events appear without automatic
sewing or camera animation. On a small screen, **Stitch detail** opens the
inspector.

![Designs, a session tag, and a handoff cord](docs/tapestry-detail.jpg)

Start a foreground server with `eventloom tapestry`; its assets and data
are served over loopback, with no external assets or CDN. Keep that process
running and open the private file path it prints. The file leads to
http://127.0.0.1:4747/?days=7 and weaves the last 7 days of the log. Change
the number in the address for more or fewer days, or remove `days` to weave
the whole log (`--days N` or `--days all` sets what the address starts with).

The port is 4747 unless you choose another. `eventloom config set
tapestry_port <n>` remembers one (1024 to 65535) in
`~/.config/eventloom/config`, and `install.sh` asks for it when run in a
terminal. `--port` or `EVENTLOOM_TAPESTRY_PORT` override it for one run.
`eventloom doctor` reports the port and whether another program holds it.

The Tapestry protects log access with a random key generated on each server
start. The private launch file, mode `0600`, carries it to the browser;
requests for log data require that key. The bare address can load the UI but
cannot read the log. A new tab or bookmark may lack the key: open the private
launch file again, or use `omarchy-shell eventloom tapestry`, which reuses an
existing server or starts one if needed. A second `eventloom tapestry` on
the same port instead fails because the port is occupied. Other processes
running as your user, root, and anyone given the key can access that run's
log data; this does not isolate the log from your own agents.
Pass `--correlation <goal-id>` (or append `correlation=<goal-id>` to the
local URL) for a read-only goal-specific weave.
Use `eventloom tapestry --demo` for a representative in-memory weave without
reading or changing your logs.
The projection and its stitch vocabulary are specified in
[`docs/tapestry-runtime.md`](docs/tapestry-runtime.md).

## Uninstall

First disable the plugin so its service stops checking for updates and
re-registering adapters. Close agent sessions that have loaded its extensions.

```sh
omarchy plugin disable syndicalt.eventloom
~/.config/omarchy/plugins/syndicalt.eventloom/uninstall.sh # keeps the logs
omarchy plugin remove syndicalt.eventloom
```

To delete event logs too, replace the uninstaller line with
`~/.config/omarchy/plugins/syndicalt.eventloom/uninstall.sh --purge`.
Run the uninstaller before removing the checkout that contains it.
The uninstaller removes the CLI/runtime, omp and Pi extensions, OpenCode
plugin, and registered Claude, Codex and other native hooks. Unrelated hooks
and plugins are retained. A hook wrapper still referenced by user-owned hooks,
or whose unregistration failed, is kept. Settings backups are also kept.
The uninstaller does not stop an already running Tapestry server.

Privileged sealed-mode setup is retained, even with the uninstaller's
`--purge`: that flag deletes the event logs and diagnostic error log, not the
protected seal file. To remove privileged setup too, first run
`eventloom seal disable` and inspect its printed sudo command while the CLI
and setup script are still present. Sealed setup's separate
`--remove --purge` option also deletes that account's seal file.

## Development

`npm run check:plugin` optionally exercises the real Quickshell service with a
disposable HOME and stub installer (requires Quickshell and Python 3). It checks
update detection, unchanged revisions, failed attempts and recovery without
installing into your account or contacting the network.

```sh
npm install
npm test        # node --test
npm run lint    # eslint, and tsc over the omp extension
npm run check   # lint and the default test suite
npm run check:codex  # optional: installed Codex, loopback model fixture
npm run check:claude # optional: installed Claude Code, loopback model fixture
npm run check:omp    # optional: installed omp, loopback model fixture
npm run check:plugin # optional: real Quickshell, isolated HOME and stub installer
```

`manifest.json` and `Service.qml` are the Omarchy plugin; `plugin/` holds the
service's setup and Tapestry-opening scripts. `omarchy plugin validate .`
rejects symlinks, including any in a development `node_modules`; validate a
checkout without those artifacts.

`EVENTLOOM_LOG_DIR` points the log somewhere else, which is how the tests
isolate themselves. The omp adapter tests load `extensions/eventloom.ts`
directly and are skipped on a Node without TypeScript support (before 22.18).

## Status

Experimental software. Native fixture checks and the live Codex UAT cover
specific versions and flows, not every agent or deployment. Known limits:

- Every append re-verifies the day's shard, so its cost grows with the shard
  and depends on storage and hardware. The omp adapter batches. Command
  hooks run in the foreground, so logging can add latency to agent work.
- Events from tool calls that Claude runs in parallel are sealed in the order
  their hooks reach the log, which may not be the order they finished in;
  `occurred_at` records when each hook ran.
- The next append or recovery attempt can reclaim a lock at least 30 seconds
  old. Appends normally wait up to 5 seconds for a held lock before failing;
  failed writes are not automatically replayed by the bundled observers. Removing the lock is an
  inference about the writer, not proof: in rare timing two writers can
  append at once, after which the shard refuses appends until
  `eventloom recover`.
- The omp adapter is exercised in tests against omp's event shapes, not
  inside a running omp in the default suite. Optional native loopback checks
  now pass on omp 18.8.6 and Claude Code 2.1.302 (`check:omp`, `check:claude`).
  The Claude hook is also tested through the installed
  script with inputs written from Claude Code's hook reference.
- Seal helper and verification flows are tested with scratch directories,
  and an existing sealed installation has been exercised with live agents.
  The complete privileged setup/remove lifecycle has not been rerun from a
  fresh system for 0.4.0.
- Except for the Codex, Claude and omp native smoke checks, adapters are
  validated against documented event contracts and installed-loader tests,
  rather than live model sessions in each agent. Agent versions can expose
  fewer hooks than their latest reference. Muse clears environment overrides
  such as `EVENTLOOM_DISABLE`; use its hook controls to disable capture there.

## Roadmap

- **Richer native coverage.** Add Hermes, OpenClaw, Kimi and Ori's own harness
  integrations beyond process capture, and validate the existing adapters
  against real installed agents. Track actual coverage and limitations in
  the matrix rather than treating hook registration as runtime validation.
- **Explore optional local summarization.** Today an agent or owner writes
  summaries explicitly. A local model might reduce reliance on agents doing
  so, but no model or inference runtime is selected or bundled, and the
  installer downloads no model. This would need decisions about reply access,
  opt-in behavior, summary quality, CPU and memory cost, and distribution.
