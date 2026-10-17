import assert from "node:assert/strict";
import { test } from "node:test";
import { NATIVE_HOOKS, missingNativeHooks, nativeHookResponse, nativeHookToEvent, unwireNativeHooks, wireNativeHooks } from "../lib/native-hooks.mjs";

const script = "/home/o'brien/.local/share/eventloom/hooks/eventloom-native-hook.sh";
const hook = { session_id: "s", sessionId: "s", conversationId: "s", conversation_id: "s", cwd: "/work", workspacePaths: ["/work"], modelName: "fixture",
  tool_name: "bash", toolName: "bash", toolCall: { name: "bash", args: { command: "PRIVATE_ARGUMENT" } },
  tool_input: { command: "PRIVATE_ARGUMENT" }, toolInput: { command: "PRIVATE_ARGUMENT" }, toolUseId: "call-a",
  transcript_path: "PRIVATE_PATH", prompt: "PRIVATE_PROMPT", initial_prompt: "PRIVATE_PROMPT", tool_output: "PRIVATE_OUTPUT" };

for (const agent of Object.keys(NATIVE_HOOKS)) {
  test(`${agent} hooks preserve other configuration and reverse cleanly`, () => {
    const existing = agent === "agy" ? { other: { PostToolUse: [{ hooks: [{ command: "user-hook" }] }] } }
      : { theme: "fixture", hooks: { Custom: [] } };
    const wired = wireNativeHooks(existing, agent, script);
    assert.deepEqual(wireNativeHooks(wired, agent, script), wired);
    assert.deepEqual(missingNativeHooks(wired, agent, script), []);
    const unwired = unwireNativeHooks(wired, agent);
    assert.equal(unwired.removed, NATIVE_HOOKS[agent].events.length);
    const expected = ["copilot", "cursor-agent"].includes(agent) ? { ...existing, version: 1 } : agent === "muse" ? { ...existing, schema_version: 1 } : existing;
    assert.deepEqual(unwired.settings, expected);
    assert.deepEqual(unwireNativeHooks(existing, agent), { settings: existing, removed: 0 });
    assert.equal(missingNativeHooks(wired, agent, "/other/eventloom-native-hook.sh").length, NATIVE_HOOKS[agent].events.length);
    assert.match(JSON.stringify(wired), /o'\\\\''brien/);
  });
  test(`${agent} hook observations drop prompt, argument and output content`, () => {
    for (const event of NATIVE_HOOKS[agent].events) {
      const draft = nativeHookToEvent(agent, event, hook, { env: {} });
      assert.equal(draft.actorId, agent);
      assert.equal(draft.payload.session_id, "s");
      assert.equal(draft.threadId, `${agent}-s`);
      assert.doesNotMatch(JSON.stringify(draft), /PRIVATE_/);
    }
    const bad = { ...hook, session_id: null, sessionId: null, conversationId: null, conversation_id: null };
    assert.throws(() => nativeHookToEvent(agent, NATIVE_HOOKS[agent].events[0], bad));
  });
}

test("native config edits refuse invalid structures and an unrelated named hook", () => {
  assert.throws(() => wireNativeHooks({ hooks: [] }, "gemini"), /left unchanged/);
  assert.throws(() => wireNativeHooks({ hooks: { BeforeTool: [{}] } }, "gemini"), /left unchanged/);
  assert.throws(() => wireNativeHooks({ "omarchy-eventloom": { SessionStart: [{ command: "user-owned" }] } }, "agy"), /already in use/);
  assert.throws(() => wireNativeHooks({ version: 9 }, "copilot"), /version/);
  const wired = wireNativeHooks({}, "copilot", script);
  wired.hooks.PreToolUse[0].matcher = "bash";
  assert.deepEqual(missingNativeHooks(wired, "copilot", script), ["PreToolUse"]);
  wired.hooks.PreToolUse[0].matcher = ".*";
  assert.deepEqual(missingNativeHooks(wired, "copilot", script), []);
});

test("native outcomes follow each agent's contract without interpreting result text", () => {
  const event = (agent, name, data = {}) => nativeHookToEvent(agent, name, { ...hook, ...data }, { env: {} });
  assert.equal(event("copilot", "PostToolUseFailure", { error: "PRIVATE_FAILURE" }).type, "agent.tool.failed");
  assert.equal(event("gemini", "AfterTool", { tool_response: { llmContent: "PRIVATE_OUTPUT", error: { message: "PRIVATE_FAILURE" } } }).type, "agent.tool.failed");
  assert.equal(event("gemini", "AfterTool", { tool_response: { llmContent: "failed text is not status" } }).payload.outcome, "success");
  assert.equal(event("grok", "PostToolUse", { toolResult: { exit_code: 7, output_for_prompt: "PRIVATE_FAILURE" } }).type, "agent.tool.failed");
  assert.equal(event("grok", "PostToolUse", { toolResult: "failed text is not status" }).payload.outcome, "unknown");
  assert.equal(event("grok", "PreToolUse").payload.tool_use_id, "call-a");
  assert.equal(event("agy", "PostToolUse", { error: "PRIVATE_FAILURE" }).type, "agent.tool.failed");
  assert.equal(event("agy", "PostToolUse", { error: "" }).payload.outcome, "success");
  assert.equal(event("grok", "Stop").type, "agent.model.completed");
  assert.equal(event("grok", "SessionEnd").type, "agent.session.completed");
  assert.throws(() => event("crush", "SessionStart"), /Unsupported/);
  assert.throws(() => event("agy", "SessionEnd"), /Unsupported/);
});

test("memory uses each native stdout protocol and never supplies a permission override", () => {
  assert.deepEqual(nativeHookResponse("copilot", "SessionStart", "brief"), { additionalContext: "brief" });
  assert.deepEqual(nativeHookResponse("gemini", "SessionStart", "brief"), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "brief" } });
  assert.deepEqual(nativeHookResponse("agy", "SessionStart", "brief"), { injectSteps: [{ systemMessage: { systemMessage: "brief" } }] });
  assert.deepEqual(nativeHookResponse("grok", "SessionStart", "brief"), {});
  for (const agent of Object.keys(NATIVE_HOOKS)) {
    assert.deepEqual(nativeHookResponse(agent, "SessionStart"), {});
    assert.deepEqual(nativeHookResponse(agent, "PreToolUse", "brief"), agent === "agy" ? { decision: "allow" } : {});
  }
});
