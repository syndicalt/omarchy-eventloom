import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const hook = fileURLToPath(new URL("../hooks/eventloom-hook.mjs", import.meta.url));

function run(event, body) {
  const home = mkdtempSync(path.join(tmpdir(), "eventloom-hook-"));
  const binDir = path.join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const log = path.join(home, "args");
  writeFileSync(path.join(binDir, "eventloom"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  chmodSync(path.join(binDir, "eventloom"), 0o755);
  const result = spawnSync(process.execPath, [hook, event], {
    input: JSON.stringify(body),
    encoding: "utf8",
    env: { ...process.env, HOME: home, EVENTLOOM_DISABLE: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  return { args: readFileSync(log, "utf8"), stderr: result.stderr, home };
}

test("claude hook records a failing tool as agent.tool.failed", () => {
  const { args } = run("post_tool", {
    session_id: "abc",
    cwd: "/work",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_response: { exit_code: 1 },
  });
  assert.match(args, /^append agent\.tool\.failed --actor claude --thread claude-abc /);
  assert.match(args, /"exit_code":1/);
  assert.match(args, /"tool":"Bash"/);
  assert.match(args, /"tool_input_keys":\["command"\]/);
  assert.doesNotMatch(args, /ls/);
});

test("claude hook keeps a successful tool completed and runs in the foreground", () => {
  const { args } = run("post_tool", {
    session_id: "abc",
    tool_name: "Read",
    tool_response: { exit_code: 0 },
  });
  assert.match(args, /^append agent\.tool\.completed /);
});

test("a missing eventloom binary is reported and does not fail the hook", () => {
  const home = mkdtempSync(path.join(tmpdir(), "eventloom-hook-"));
  const result = spawnSync(process.execPath, [hook, "session_start"], {
    input: JSON.stringify({ session_id: "abc" }),
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /eventloom:/);
});
