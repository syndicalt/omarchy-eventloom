// The agent event types eventloom names, and the family the tapestry draws
// each one as. The bundled adapters emit a subset (see the README table).
// The log accepts any well-formed type; unknown types are stored as-is and
// drawn as "other".
const EVENT_FAMILY = Object.freeze({
  "agent.session.started": "lifecycle",
  "agent.session.resumed": "lifecycle",
  "agent.session.completed": "lifecycle",
  "agent.session.failed": "lifecycle",
  "agent.model.started": "model",
  "agent.model.completed": "model",
  "agent.tool.started": "tool",
  "agent.tool.completed": "tool",
  "agent.tool.failed": "tool",
  "agent.approval.requested": "approval",
  "agent.approval.resolved": "approval",
  "agent.file.mutated": "file",
  "agent.git.mutated": "git",
  "agent.handoff": "handoff",
  "agent.note.added": "note",
});

// Written by the store itself when it opens a daily shard.
export const SHARD_ANCHOR_TYPE = "eventloom.shard.anchored";
// Written by `recover` and `purge`: that shard was cut back or removed on purpose.
export const SHARD_ACK_TYPE = "eventloom.shard.acknowledged";

export function familyOf(type) {
  return EVENT_FAMILY[type] ?? "other";
}
