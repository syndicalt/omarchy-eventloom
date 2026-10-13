# Sealed mode and installer settings: design

Status: built. Two changes that share the installer work: an opt-in sealed
mode, and a persistent setting for the tapestry's port.

## Sealed mode

### The problem

The log is a hash chain, and its head is the last line of today's shard.
Nothing outside the log directory holds that head, so a process running as
the log's owner, an agent included, can rewrite the log and recompute every
hash, or cut events off the end. `eventloom verify` cannot tell.

No file format fixes this. On one machine, under one user, that user's
processes can change that user's files. A local fix needs a second privilege
domain: somewhere the agent cannot write that remembers how far the log had
got.

### What it guarantees

With sealed mode on, `eventloom verify` detects:

- any change to an event that was sealed, or to one before it;
- a shard cut back below its last seal;
- a deleted day that had been sealed.

`purge` and `recover` still work, and an agent can still run them, but each
leaves a record in the seal file that cannot be removed. The gap is permanent
evidence.

It does not detect: false events an agent appends (a seal says what the log
held at a time, not that it was true), changes to the events written since
the last seal, or anything done with root.

### The parts

Unix permissions have no "append-only for somebody else". So the agent never
writes the seal file. It asks a helper, which runs as another user, to append.

| Part | What it is |
|---|---|
| Seal user | A system account, `eventloom-seal`, with no login shell. |
| Seal file | `/var/lib/eventloom-seal/<uid>.evtseal`. Owned by the seal user, group the log owner's primary group, mode `0640`: the owner reads it, nobody but the seal user writes it. One file per log owner, so several users of a machine can each seal. |
| Helper | `/usr/local/libexec/eventloom-seal`, owned by root, mode `0755`. POSIX shell and `sha256sum`, `flock`, `date` from the system. It runs nothing from a home directory, because the agent can change what is there. |
| Sudoers rule | `/etc/sudoers.d/eventloom-seal-<user>`, one per sealed account: that user may run the helper, and only the helper, as `eventloom-seal` without a password. Checked with `visudo -c` before it is installed. |

The helper takes the calling user from `SUDO_UID`, which sudo sets and the
caller cannot, and writes only that user's file.

### The seal file

Text, one record a line, so it can be read and searched with ordinary tools.

```
eventloom-seal 1 uid=1000 log=/home/me/.local/state/omarchy/agents/logs
1 2026-10-13T12:45:22Z head 2026-10-13 412 sha256:<event hash> sha256:<link>
2 2026-10-13T12:51:07Z ack 2026-10-11 0 purged sha256:<link>
```

- The first line names the format, its version, and the log directory the
  seal is of. Eventloom seals to it and verifies against it only when that is
  the directory its log is in, so a log kept elsewhere by `EVENTLOOM_LOG_DIR`
  (a test's, a sandbox's) never touches the seal.
- Fields: sequence number, time, kind, shard day, position (the count of
  events in that shard), then the hash of the event at that position for a
  `head`, or what was done for an `ack`.
- `link` is the SHA-256 of the previous line's link and this line's other
  fields, so the file is a chain of its own.
- The time is the helper's clock, not the caller's: an agent cannot backdate
  a seal.
- It holds hashes, positions and times. No log content.

### What the helper checks

- The request is four arguments, each matched whole against a strict pattern:
  a kind, a day, a whole number, and a hash in hex or `purged`/`recovered`.
  Anything else is refused, including an argument that holds a line break,
  which could otherwise smuggle a second, forged record into the file.
- A `head` must move forward: a later day, or the same day at a higher
  position. A lower one is refused unless an `ack` for that shard comes
  first.
- Appends are serialized with a lock on the seal file.

The helper does not read the log. It records what it is told; `verify`
compares that with the log afterwards.

### When the log is sealed

- When a session starts and when it ends.
- Whenever 10 events have been written since the last seal.

So at most 9 events, plus whatever a crashed session left, are unsealed at
any time. Sealing each event was rejected: it costs a `sudo` call and a line
in the system's auth log per tool call.

The event is written first and sealed after. If sealing fails the event
stays, the failure goes to the error log, and `eventloom doctor` reports it.
The log may therefore run ahead of its seals, never behind.

### Verify

For every `head` in the seal file, the shard for that day must hold, at that
position, an event with that hash. Because each event's hash covers the one
before, this fixes everything up to that position. `verify` also checks the
seal file's own chain and reports how many events are not yet sealed.

A shard that an `ack` covers is checked from the `ack` onward.

### No switch the agent can reach

Whether sealing is on is not a setting in the owner's home. If a seal file
exists for the owner's uid, `verify` checks against it and the store seals
to it. An agent cannot turn sealed mode off by editing a file; it can only
stop sealing, which shows as a growing count of unsealed events.

### Install, update, removal

- In a terminal, `install.sh` asks `Enable sealed mode? [y/N]`. On yes it
  prints one `sudo` command, which runs `seal/setup.sh`: create the seal
  user, install the helper and the sudoers rule, create the seal file.
- Through the Omarchy plugin there is no terminal to ask in, so the install
  is unsealed. `eventloom seal enable` prints the same command later.
- Eventloom never runs `sudo` for setup itself. The owner types it.
- `omarchy plugin update` cannot update the helper, which root owns.
  `doctor` compares versions and says when to run the setup command again.
- `eventloom seal disable` prints the command that removes the helper and
  the rule. The seal file is kept unless `--purge` is given; the log then
  verifies as an unsealed log does today.

### Who checks the checker

`eventloom verify` runs from the owner's home directory, which an agent can
write. An agent set on hiding tampering can change the verifier as easily as
the log. Sealed mode does not prevent that; it guarantees that the evidence
survives. The seal file is plain text and each `head` can be compared by hand
with the shard, or by a copy of eventloom the agent has not touched.

### Costs and open points

- The marketplace's scan will report a privilege request, correctly, and the
  update will need a closer review.
- Measured on Omarchy (sudo 1.9.17): `sudo` adds about 11 ms to a call, a
  seal takes about 36 ms in all, and each writes three lines to the system
  journal. At a seal every 10 events that is a few dozen seals on a busy day.
- A socket-activated systemd service running as the seal user could replace
  `sudo` and its auth-log lines. To be considered only if `sudo` proves too
  slow or too noisy.
- External anchoring (pushing head hashes off the machine) remains the only
  answer to an attacker with root. It is not part of this design.

## Tapestry port setting

### Today

The tapestry listens on 4747 unless `--port` is given. The plugin's open
command also reads `EVENTLOOM_TAPESTRY_PORT`. Nothing is remembered, and the
two do not share a setting.

### Design

- One settings file, `~/.config/eventloom/config`, of `key=value` lines. It
  starts with one key: `tapestry_port=4747`.
- Read by `eventloom tapestry` and by `plugin/open-tapestry.sh`, so they
  agree.
- Precedence: `--port`, then `EVENTLOOM_TAPESTRY_PORT`, then the file, then
  4747.
- In a terminal, `install.sh` asks `Tapestry port [4747]:`. Through the
  plugin the port stays 4747 until changed.
- `eventloom config set tapestry_port <n>` and `eventloom config get
  tapestry_port` change and read it. A port must be a whole number from 1024
  to 65535.
- `eventloom doctor` reports the configured port and whether something else
  holds it.

Other preferences that are environment variables today (`EVENTLOOM_MEMORY`,
`EVENTLOOM_MODE`) are left as they are in this change.

Sealed mode is deliberately not a key in this file; see "No switch the agent
can reach".

## Order of work

1. Settings file and tapestry port. Small, no privilege, can ship alone.
2. Seal helper and its setup script, with tests that run the helper as the
   current user against a scratch file.
3. Sealing from the store, and `verify` against the seal file.
4. `eventloom seal enable|disable|status`, the installer's questions, doctor.
5. README: Integrity rewritten around the two modes.
