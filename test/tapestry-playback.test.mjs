import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedActions, progressAt, sewingAt } from "../tapestry/playback.mjs";

const actions = [
  { id: "summary", key: "research", t: 1000, t1: 1000, birth: 1, sewn: 2 },
  { id: "recall", key: "build", t: 3000, t1: 3000, birth: 3, sewn: 4 },
  { id: "tool", key: "build", t: 5000, t1: 7000, birth: 5, sewn: 6 },
  { id: "unrelated", key: "other", t: 8000, t1: 8000, birth: 7, sewn: 8 },
];

test("the replay clock can seek backwards and bounds its position", () => {
  assert.equal(progressAt(10, 20, 40), 0);
  assert.equal(progressAt(50, 20, 40), 1);
  assert.equal(progressAt(10, 10, 10), 1);
  assert.equal(sewingAt([], 0.5, 12), 12);
  assert.equal(sewingAt(actions, 1, 12), 12);
  const forward = sewingAt(actions, 0.6, 12);
  const backward = sewingAt(actions, 0.2, 12);
  assert.ok(backward < forward);
  assert.equal(sewingAt(actions, 0, 12), 0);
  assert.equal(sewingAt(actions, -1, 12), 0);
  assert.equal(sewingAt(actions, 2, 12), 12);
  assert.equal(sewingAt(actions, 2 / 7, 12), actions[1].birth);
});

test("connection tracing includes both directions without unrelated sessions", () => {
  const [summary, recall, tool, unrelated] = actions;
  const links = [{ from: summary, to: recall, kind: "memory" }, { from: recall, to: tool, kind: "cause" }];
  assert.deepEqual([...connectedActions(links, null)], []);
  assert.deepEqual([...connectedActions(links, { action: summary })].sort(), ["recall", "summary"]);
  assert.deepEqual([...connectedActions(links, { action: recall })].sort(), ["recall", "summary", "tool"]);
  assert.deepEqual([...connectedActions(links, { band: { actions: [recall, tool] } })].sort(), ["recall", "summary", "tool"]);
  assert.deepEqual([...connectedActions(links, { action: unrelated })], ["unrelated"]);
});
