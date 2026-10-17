import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL, bandCapacity, buildActions, layoutWeave } from "../tapestry/layout.mjs";
import { demoEvents, deriveSessions, weaveSpec } from "../tapestry/server.mjs";

const at = (minutes) => new Date(Date.UTC(2026, 9, 10, 12, 0) + minutes * 60_000).toISOString();
const line = (id, minutes, type, session, extra = {}) => ({
  id, ts: at(minutes), type,
  family: type.includes("tool") ? "tool" : type.includes("handoff") ? "handoff" : type.includes("session") ? "lifecycle" : "note",
  actor: extra.actor ?? "omp", thread: "main", session, ok: !type.endsWith(".failed"), duration: 0, ...extra,
});

test("process capture gets a separate completed or failed band beside its native session", () => {
  const stitches = [
    line("p1", 0, "agent.process.started", "process", { family: "lifecycle" }),
    line("s1", 1, "agent.session.started", "native"),
    line("s2", 2, "agent.session.completed", "native"),
    line("p2", 3, "agent.process.completed", "process", { family: "lifecycle" }),
    line("f1", 4, "agent.process.started", "failed", { family: "lifecycle" }),
    line("f2", 5, "agent.process.failed", "failed", { family: "lifecycle" }),
  ];
  const weave = layoutWeave({ stitches, links: [] });
  const sessions = deriveSessions(stitches);
  for (const bands of [weave.bands, sessions]) {
    assert.equal(bands.length, 3);
    assert.equal(bands.find((band) => band.sessionId === "process").status, "completed");
    assert.equal(bands.find((band) => band.sessionId === "process").process, true);
    assert.equal(bands.find((band) => band.sessionId === "native").process, false);
    assert.equal(bands.find((band) => band.sessionId === "failed").status, "failed");
  }
});

test("a tool's start and end are one action", () => {
  const actions = buildActions([
    line("a", 0, "agent.tool.started", "s", { tool: "bash" }),
    line("b", 1, "agent.tool.completed", "s", { tool: "bash", duration: 60_000 }),
    line("c", 2, "agent.tool.started", "s", { tool: "read" }),
    line("d", 3, "agent.tool.failed", "s", { tool: "read" }),
    line("e", 4, "agent.tool.started", "s", { tool: "bash" }),
  ]);
  assert.equal(actions.length, 3);
  assert.deepEqual(actions[0].events.map((event) => event.id), ["a", "b"]);
  assert.equal(actions[0].pending, false);
  assert.equal(actions[0].duration, 60_000);
  assert.equal(actions[1].ok, false);
  assert.equal(actions[2].pending, true);
});

test("an end with no start still gets stitched", () => {
  const actions = buildActions([line("b", 1, "agent.tool.completed", "s", { tool: "bash" })]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].pending, false);
});

test("later never sits below earlier", () => {
  const weave = layoutWeave(weaveSpec(demoEvents()));
  const ordered = [...weave.actions].sort((a, b) => a.t - b.t);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].t - ordered[i - 1].t > 60 * 60_000) continue;
    assert.ok(ordered[i].row >= ordered[i - 1].row - 3, `${ordered[i].id} fell below ${ordered[i - 1].id}`);
  }
  for (const band of weave.bands) {
    const rows = band.actions.map((action) => action.row);
    assert.deepEqual(rows, [...rows].sort((a, b) => a - b), band.key);
  }
});

test("no two designs share a place", () => {
  const weave = layoutWeave(weaveSpec(demoEvents()));
  for (const a of weave.actions) {
    for (const b of weave.actions) {
      if (a === b) continue;
      const apart = Math.abs(a.x - b.x) >= (a.width + b.width) / 2 - 1e-6 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2 - 1e-6;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
  for (const action of weave.actions) {
    assert.ok(action.x - action.width / 2 >= -1e-6 && action.x + action.width / 2 <= weave.width + 1e-6);
    assert.ok(action.y - action.height / 2 >= -1e-6 && action.y + action.height / 2 <= weave.height + 1e-6);
  }
});

test("a busy band holds more designs abreast", () => {
  assert.equal(bandCapacity(1), 1);
  assert.ok(bandCapacity(200) > bandCapacity(20));
  const burst = [line("s", 0, "agent.session.started", "busy")];
  for (let i = 0; i < 30; i++) burst.push(line("n" + i, 1 + i / 100, "agent.note.added", "busy"));
  const weave = layoutWeave({ stitches: burst, links: [] });
  const widest = Math.max(...weave.actions.filter((action) => !action.border).map((action) => action.span));
  assert.equal(widest, weave.bands[0].capacity);
  assert.ok(weave.height < 30 * CELL);
});

test("events with no session are gathered per actor", () => {
  const weave = layoutWeave({
    stitches: [
      line("a", 0, "agent.note.added", null, { actor: "fleet", thread: "t1" }),
      line("b", 1, "agent.note.added", null, { actor: "fleet", thread: "t2" }),
      line("c", 2, "agent.note.added", "real", { actor: "omp" }),
    ],
    links: [],
  });
  assert.deepEqual(weave.bands.map((band) => band.key).sort(), ["fleet", "real"]);
});

test("yarn joins actions, and only where it says something", () => {
  const weave = layoutWeave(weaveSpec(demoEvents()));
  const kinds = weave.links.map((link) => link.kind).sort();
  // research's and review's summaries are recalled by build, and research's
  // again by experiment
  assert.deepEqual(kinds, ["cause", "cause", "handoff", "memory", "memory", "memory", "resume"]);
  const remembered = weave.links.filter((link) => link.kind === "memory");
  assert.deepEqual(remembered.map((link) => `${link.from.band.sessionId}>${link.to.band.sessionId}`).sort(),
    ["research>build", "research>experiment", "review>build"]);
  for (const link of weave.links) assert.notEqual(link.from, link.to);
  const handoff = weave.links.find((link) => link.kind === "handoff");
  assert.equal(handoff.from.band.sessionId, "research");
  assert.equal(handoff.to.band.sessionId, "build");

  const adjacent = layoutWeave({
    stitches: [line("a", 0, "agent.session.started", "s"), line("b", 0.1, "agent.session.resumed", "s")],
    links: [{ from: "a", to: "b", kind: "resume" }, { from: "a", to: "missing", kind: "cause" }],
  });
  assert.equal(adjacent.links.length, 0);
});

test("an empty log lays out as an empty cloth", () => {
  const weave = layoutWeave({ stitches: [] });
  assert.equal(weave.actions.length, 0);
  assert.equal(weave.width, 0);
});
