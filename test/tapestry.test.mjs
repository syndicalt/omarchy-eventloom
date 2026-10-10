import assert from "node:assert/strict";
import { test } from "node:test";
import { activityBinCount, demoEvents, deriveSessions, placeColumns, weaveSpec } from "../tapestry/server.mjs";

const at = (minutes) => new Date(Date.UTC(2026, 9, 10, 12, minutes)).toISOString();

function stitch(id, minutes, type, session, extra = {}) {
  return {
    id,
    ts: at(minutes),
    type,
    family: type.includes("handoff") ? "handoff" : type.includes("tool") ? "tool" : "lifecycle",
    actor: extra.actor ?? "omp",
    thread: "main",
    session,
    ok: extra.ok ?? !type.endsWith(".failed"),
    duration: extra.duration ?? 0,
    payload: extra.payload ?? {},
  };
}

test("a later start is not drawn as a resume splice", () => {
  const sessions = deriveSessions([
    stitch("a", 0, "agent.session.started", "build"),
    stitch("b", 10, "agent.session.completed", "build"),
    stitch("c", 20, "agent.session.started", "build"),
  ]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].resumed, false);
  assert.equal(sessions[1].resumeOf, null);
});

test("resume links only the resumed segment", () => {
  const sessions = deriveSessions([
    stitch("a", 0, "agent.session.started", "review"),
    stitch("b", 30, "agent.session.resumed", "review"),
  ]);
  assert.equal(sessions[0].resumeOf, null);
  assert.equal(sessions[1].resumed, true);
  assert.equal(sessions[1].resumeOf, sessions[0].id);
});

test("overlapping sessions get distinct columns and sequential ones can share", () => {
  const sessions = deriveSessions([
    stitch("a", 0, "agent.session.started", "one"),
    stitch("b", 30, "agent.session.completed", "one"),
    stitch("c", 10, "agent.session.started", "two"),
    stitch("d", 40, "agent.session.completed", "two"),
    stitch("e", 80, "agent.session.started", "three"),
    stitch("f", 100, "agent.session.completed", "three"),
  ]);
  const columns = placeColumns(sessions);
  const byId = Object.fromEntries(sessions.map((session) => [session.sessionId, session.column]));
  assert.notEqual(byId.one, byId.two);
  assert.equal(byId.one, byId.three);
  assert.equal(columns, 2);
});

test("multi-day segments use daily buckets", () => {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  const end = Date.parse("2026-10-04T00:00:00.000Z");
  assert.equal(activityBinCount(start, end), 3);
  assert.equal(activityBinCount(start, start + 2 * 60 * 60 * 1000), 6);
});

test("a bad timestamp cannot pin the weave to the epoch", () => {
  const spec = weaveSpec([
    { id: "bad", ts: "not-a-time", type: "agent.note.added", family: "note", actor: "omp", session: "x", ok: true, payload: {} },
    stitch("good", 5, "agent.session.started", "x"),
  ]);
  assert.deepEqual(spec.skipped, ["bad"]);
  assert.equal(spec.span.t0, at(5));
  assert.ok(spec.sessions.every((session) => session.start > Date.parse("2026-01-01T00:00:00.000Z")));
});

test("handoffs follow to_session_id", () => {
  const spec = weaveSpec(demoEvents());
  assert.equal(spec.handoffs.length, 1);
  assert.equal(spec.handoffs[0].toSession, "build");
  assert.equal(spec.handoffs[0].fromSession, "research");
  const review = spec.sessions.filter((session) => session.sessionId === "review");
  assert.equal(review.length, 2);
  assert.equal(review[1].resumed, true);
  assert.equal(review[1].resumeOf, review[0].id);
});
