import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../extensions/eventloom.ts", import.meta.url), "utf8");

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1);
  return source.slice(from, to);
}

test("omp turns do not close or resume the session", () => {
  assert.match(between('pi.on("agent_start"', 'pi.on("tool_execution_start"'), /openSession\(ctx, "agent_start", false\)/);
  const end = between('pi.on("agent_end"', 'pi.on("session_shutdown"');
  assert.doesNotMatch(end, /sessionKey = undefined/);
  assert.doesNotMatch(end, /agent\.session\.completed/);
  const shutdown = source.slice(source.indexOf('pi.on("session_shutdown"'));
  assert.match(shutdown, /agent\.session\.completed/);
  assert.match(shutdown, /sessionKey = undefined/);
});

test("omp session_switch adopts the destination session", () => {
  const block = between('pi.on("session_switch"', 'pi.on("agent_start"');
  assert.match(block, /sessionKey = undefined/);
  assert.match(block, /openSession\(ctx, event\?\.reason \?\? "switch", true\)/);
  assert.match(source, /"--thread", thread/);
  assert.match(source, /detached: true/);
});
