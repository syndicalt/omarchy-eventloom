import assert from "node:assert/strict";
import { test } from "node:test";
import { FINE, LOOSE, TONE, glyph, motifFor } from "../tapestry/motif.mjs";

const tool = (id, extra = {}) => ({
  id, type: "agent.tool.completed", family: "tool", tool: "bash", glyph: "bash", ok: true, pending: false, duration: 1900, ...extra,
});

test("a glyph is symmetric eight ways and never bare", () => {
  for (const key of ["bash", "read", "edit", "apply_patch", "x"]) {
    for (const size of [5, 7, 9]) {
      const grid = glyph(key, size);
      const last = size - 1;
      let filled = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          assert.equal(grid[y][x], grid[y][last - x]);
          assert.equal(grid[y][x], grid[last - y][x]);
          assert.equal(grid[y][x], grid[x][y]);
          if (grid[y][x] >= 0) filled++;
        }
      }
      assert.ok(filled >= 5, `${key}/${size} has ${filled} cells`);
    }
  }
});

test("one tool is one design, whichever log line it came from", () => {
  const a = motifFor(tool("evt-a"));
  const b = motifFor(tool("evt-b"));
  assert.deepEqual(a.stitches, b.stitches);
  assert.notDeepEqual(a.stitches, motifFor(tool("evt-a", { tool: "read", glyph: "read" })).stitches);
  assert.deepEqual(motifFor(tool("evt-a")), a);
});

test("an action is a design of many stitches, not a single mark", () => {
  const types = [
    ["agent.tool.completed", "tool"], ["agent.approval.requested", "approval"], ["agent.approval.resolved", "approval"],
    ["agent.model.started", "model"], ["agent.file.mutated", "file"], ["agent.git.mutated", "git"],
    ["agent.handoff", "handoff"], ["agent.session.resumed", "lifecycle"], ["agent.note.added", "note"], ["agent.bench", "other"],
    ["agent.session.started", "lifecycle"], ["agent.session.completed", "lifecycle"], ["agent.session.failed", "lifecycle"],
  ];
  for (const [type, family] of types) {
    const motif = motifFor({ id: "e", type, family, glyph: type, ok: !type.endsWith("failed"), duration: 0 }, 23);
    assert.ok(motif.stitches.length + motif.knots.length >= 10, `${type}: ${motif.stitches.length} stitches`);
    for (const s of motif.stitches) {
      assert.ok(s.slice(0, 4).every(Number.isFinite), type);
      assert.ok(Math.hypot(s[2] - s[0], s[3] - s[1]) > 0.05, `${type} has a zero-length stitch`);
      assert.ok(Math.abs(s[0]) <= 13 && Math.abs(s[1]) <= 9, `${type} leaves its cell`);
    }
  }
});

test("a half-finished tool is left half stitched", () => {
  const done = motifFor(tool("e"));
  const open = motifFor(tool("e", { pending: true, type: "agent.tool.started", duration: 0 }));
  const legs = (motif) => motif.stitches.filter((s) => !(s[5] & FINE)).length;
  assert.equal(legs(open) * 2, legs(done));
});

test("a failure frays", () => {
  const motif = motifFor(tool("e", { ok: false, type: "agent.tool.failed" }));
  assert.ok(motif.stitches.some((s) => s[4] === TONE.rust));
  assert.ok(motif.stitches.some((s) => s[5] & LOOSE));
  assert.ok(!motifFor(tool("e")).stitches.some((s) => s[5] & LOOSE));
});

test("a session border spans its band", () => {
  for (const type of ["agent.session.started", "agent.session.completed", "agent.session.failed"]) {
    for (const width of [11, 35]) {
      const motif = motifFor({ id: "e", type, family: "lifecycle", ok: true }, width);
      const xs = motif.stitches.flatMap((s) => [s[0], s[2]]);
      assert.ok(Math.max(...xs) - Math.min(...xs) > width - 3, `${type} at ${width}`);
      assert.ok(Math.max(...xs.map(Math.abs)) <= width / 2 + 1.5, `${type} at ${width}`);
    }
  }
});
