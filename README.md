# omarchy-eventloom

A local, append-only event log shared by the AI agents running on Omarchy,
built on [@eventloom/runtime](https://github.com/syndicalt/eventloom).

Each agent's adapter writes to one hash-chained JSONL shard per local day:

```
~/.local/state/omarchy/agents/logs/2026-10-10.jsonl
```

## Why

Agents on the same machine work blind to each other, and each stores its
sessions in its own place and format. omarchy-eventloom gives them one record
of what ran, which tools were used, what needed approval, what completed or
failed, and how sessions join into a task (`correlation_id`).

## Install

```sh
git clone <this repo> ~/Projects/omarchy-eventloom
~/Projects/omarchy-eventloom/install.sh
```

Requires `bun`, or `node >= 20` with `npm`. The installer copies the code to
`~/.local/lib/eventloom`, installs `@eventloom/runtime` there exactly as
`package-lock.json` pins it, wires the adapters for the agents it finds, and
finishes by running `eventloom doctor`. Run it again to upgrade.

## Usage

```sh
eventloom append agent.note.added --actor me --payload '{"text":"hello"}'
eventloom tail --limit 20 --actor omp   # newest events, across shards
eventloom verify                        # every shard and the links between them; exit 2 on failure
eventloom doctor                        # log health and adapter wiring
eventloom recover                       # set a damaged shard aside, keep its verified prefix
eventloom purge 2026-10-10              # delete one day's shard and record that it was
eventloom path                          # today's shard
```

`omarchy-eventloom` and `omarchy-eventloom-inspect` are aliases for
`eventloom` and `eventloom doctor`.

## Events

| Type | Meaning | Emitted by |
|---|---|---|
| `agent.session.started` / `resumed` / `completed` | session lifecycle | omp, claude |
| `agent.model.started` / `completed` | one model turn, with `duration_ms` | omp |
| `agent.tool.started` / `completed` / `failed` | tool calls; inputs as argument names only | omp, claude (no `started`) |
| `agent.approval.requested` / `resolved` | human-in-the-loop | omp |
| `agent.note.added` | free-form annotation | `eventloom append` |
| `eventloom.shard.anchored` | opens a shard; links it to the previous one | the store |
| `eventloom.shard.acknowledged` | a shard was recovered or purged on purpose | `recover`, `purge` |

The tapestry also recognises `agent.session.failed`, `agent.handoff`,
`agent.file.mutated` and `agent.git.mutated`; no bundled adapter emits them
yet. Any well-formed type is accepted and stored, except the `eventloom.*`
types, which only eventloom itself writes.

Adapter payloads carry `session_id`, `correlation_id` and `occurred_at`.
`occurred_at` is when the event happened; the envelope `timestamp` is when it
was sealed. Set `EVENTLOOM_CORRELATION_ID` in an agent's environment to join
its sessions to a task shared with other agents; otherwise each session
correlates only with itself.

## Adapters

- **omp** — `extensions/eventloom.ts`, copied to `~/.omp/agent/extensions/`.
  Queues events in memory and writes them in order through one
  `eventloom ingest` process at a time. At shutdown whatever is still queued
  goes to a second process at once, so omp is never kept waiting; those last
  events can be sealed out of order, and `occurred_at` gives the true one.
- **claude** — `hooks/eventloom-hook.sh`, registered in
  `~/.claude/settings.json` for `SessionStart`, `SessionEnd`, `PostToolUse` and
  `PostToolUseFailure`. `settings.json` is never rewritten if it cannot be
  parsed, other hooks are left in place, and the previous contents are kept
  as `settings.json.eventloom-backup`.

To add an adapter: capture the agent's events out of band (its hooks or
extension API, not a proxy), pipe them to `eventloom ingest` as one
`{"type","actor","thread","payload"}` object per line, and add an entry to
`lib/adapters.json` so `eventloom doctor` checks it.

Adapters never write to the agent's terminal. A failed write goes to
`~/.local/state/omarchy/agents/eventloom-errors.log`, and `eventloom doctor`
reports it.

## Privacy

- The bundled adapters record what happened, not what was said: tool names
  and argument names, never arguments, output or prompts. Content only
  enters the log through `eventloom append`, a third-party `ingest`, or an
  error message.
- Everything is redacted before sealing, because a sealed event cannot be
  edited. In a structured payload this is exact: every string or number under
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
- `EVENTLOOM_MODE=full` (default) | `summary` (every string cut to 200
  characters) | `metadata` (an allow-list of structural fields, no content).
- `EVENTLOOM_DISABLE=1` opts an agent out.
- The log directory is mode `0700` and shards are `0600`. Nothing leaves the
  machine. `eventloom purge <day>` deletes a day, with any copies `recover`
  set aside for it, and records that it did, so `verify` reports the gap as
  acknowledged and not as tampering.

## Integrity

Each shard is a SHA-256 hash chain, and each new shard opens with an anchor
holding the previous shard's name and the hash and position of its last event
at that moment. `eventloom verify` therefore detects an edited or reordered
event, a deleted day, and a previous shard cut back past its anchor. Gaps left
by `eventloom recover` and `eventloom purge` are recorded in the log and
reported as warnings; anything that changes after such a record is an error
again.

It does not detect removal of events from the end of the newest shard (or of
events appended to an older shard after it was anchored), and the chain is
not signed: a process running as you can rewrite the log and
recompute every hash, or append events under another agent's name. Treat the
log as a tamper-evident record against accident and casual edits, and treat
what agents read from it as untrusted input.

## Visualization

The **Tapestry** is a read-only view of the log as needlework, rendered with
three.js: evenweave linen on a rod, every logged action embroidered as its
own counted design, each session a band growing upward from its start, and
handoffs, forks, resumes and shared goals strung between designs as plied
yarn. New log lines are stitched in as they arrive.

![Designs, a session tag, and a handoff cord](docs/tapestry-detail.jpg)

Start it with `eventloom tapestry`; it serves locally and loads nothing from
the network. The address it prints, http://127.0.0.1:4747/?days=7, weaves the
last 7 days of the log. Change the number in the address for more or fewer
days, or remove `days` to weave the whole log (`--days N` or `--days all`
sets what the printed address starts with).
Pass `--correlation <goal-id>` (or append `correlation=<goal-id>` to the
local URL) for a read-only goal-specific weave.
Use `eventloom tapestry --demo` for a representative in-memory weave without
reading or changing your logs.
The projection and its stitch vocabulary are specified in
[`docs/tapestry-runtime.md`](docs/tapestry-runtime.md).

## Uninstall

```sh
~/Projects/omarchy-eventloom/uninstall.sh           # keeps the logs
~/Projects/omarchy-eventloom/uninstall.sh --purge   # deletes them too
```

Removes the installed files and unregisters the Claude hooks, leaving every
other hook untouched.

## Development

```sh
npm install
npm test        # node --test
npm run lint    # eslint, and tsc over the omp extension
```

`EVENTLOOM_LOG_DIR` points the log somewhere else, which is how the tests
isolate themselves. The omp adapter tests load `extensions/eventloom.ts`
directly and are skipped on a Node without TypeScript support (before 22.18).

## Status

Prototype. Known limits:

- Every append re-verifies the day's shard, so its cost grows with the shard
  (about 0.5 s at 30,000 events). The omp adapter batches. The Claude hook
  runs in the foreground and pays this once per tool call.
- Events from tool calls that Claude runs in parallel are sealed in the order
  their hooks reach the log, which may not be the order they finished in;
  `occurred_at` records when each hook ran.
- A lock file left by a killed writer is removed after 30 seconds. Until
  then each append waits 5 seconds for the lock and fails, and those events
  are lost (the failures are in the error log). Removing the lock is an
  inference about the writer, not proof: in rare timing two writers can
  append at once, after which the shard refuses appends until
  `eventloom recover`.
- The omp adapter is exercised in tests against omp's event shapes, not
  inside a running omp. The Claude hook is tested through the installed
  script with inputs written from Claude Code's hook reference.
- No adapters yet for Codex, Grok or opencode.
