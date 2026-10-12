// The one path every event takes into the log: provenance, then redaction
// and the capture mode, then sealing. Nothing reaches the store unredacted.
import { eventTypeSchema } from "@eventloom/runtime";
import { withSessionProvenance } from "./provenance.mjs";
import { isPlainObject } from "./shape.mjs";
import { applyCaptureMode, captureMode, redactString } from "./redact.mjs";
import { appendEvents } from "./store.mjs";

const DEFAULT_THREAD = "thread_main";
// e.g. the shard anchors, which `verify` trusts to describe the chain
const RESERVED_PREFIX = "eventloom.";

// Validates one adapter-supplied event: { type, actor, thread?, payload? }.
export function draftFromAdapter(input) {
  if (!isPlainObject(input)) throw new Error("event is not a JSON object");
  const { type, actor, thread = DEFAULT_THREAD, payload = {} } = input;
  if (typeof type !== "string" || type === "") throw new Error("event has no type");
  if (!eventTypeSchema.safeParse(type).success) {
    throw new Error(`"${type}" is not an event type (lowercase alphanumeric words joined by dots)`);
  }
  if (type.startsWith(RESERVED_PREFIX)) throw new Error(`${RESERVED_PREFIX}* event types are written by eventloom itself`);
  if (typeof actor !== "string" || actor === "") throw new Error(`${type} event has no actor`);
  if (typeof thread !== "string" || thread === "") throw new Error(`${type} event has an empty thread`);
  if (!isPlainObject(payload)) throw new Error(`${type} event payload is not a JSON object`);
  return { type, actorId: actor, threadId: thread, payload };
}

// One event made ready to seal: provenance added, everything redacted.
export function prepareEvent(draft, mode = captureMode()) {
  return {
    type: draft.type,
    actorId: redactString(draft.actorId),
    threadId: redactString(draft.threadId),
    payload: applyCaptureMode(withSessionProvenance(draft.type, draft.payload), mode),
  };
}

// `events` must come from prepareEvent.
export function sealEvents(events, logPath) {
  return appendEvents(events, logPath);
}

export function recordEvents(drafts, logPath) {
  const mode = captureMode();
  return sealEvents(drafts.map((draft) => prepareEvent(draft, mode)), logPath);
}
