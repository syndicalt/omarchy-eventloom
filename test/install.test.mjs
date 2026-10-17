// Runs the shell entry points for real: install.sh, the launcher, the Claude
// hook and uninstall.sh, against a throwaway HOME. `npm` is a stand-in that
// copies this checkout's node_modules, so no network is involved.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir, until } from "./helpers.mjs";
import { NATIVE_HOOKS, nativeHookResponse } from "../lib/native-hooks.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FAKE_NPM = `#!/bin/sh
# stands in for: npm ci --prefix <dir> ...
[ "\${FAKE_NPM_FAIL:-0}" = "1" ] && { echo "npm error network unreachable" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  [ "$1" = "--prefix" ] && { prefix="$2"; break; }
  shift
done
mkdir -p "$prefix/node_modules"
cp -R "${REPO}node_modules/@eventloom" "${REPO}node_modules/zod" "${REPO}node_modules/nanoid" "${REPO}node_modules/three" "$prefix/node_modules/"
`;

function machine(t) {
  const home = tempDir(t, "install");
  const tools = path.join(home, "tools");
  mkdirSync(tools);
  mkdirSync(path.join(home, ".claude"));
  writeFileSync(path.join(tools, "npm"), FAKE_NPM, { mode: 0o755 });
  const basePath = `${tools}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const sh = (script, args = [], { env = {}, input = "" } = {}) => {
    const result = spawnSync("sh", [script, ...args], {
      input,
      encoding: "utf8",
      env: { HOME: home, PATH: basePath, ...env },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const eventloom = path.join(home, ".local", "bin", "eventloom");
  return {
    home,
    tools,
    basePath,
    sh,
    eventloom: (args, options) => sh(eventloom, args, options),
    install: (options, args = []) => sh(path.join(REPO, "install.sh"), args, options),
    uninstall: (args) => sh(path.join(REPO, "uninstall.sh"), args),
    pluginSetup: (args = [], options) => sh(path.join(REPO, "plugin", "setup.sh"), args, options),
    hook: (input, options) => sh(path.join(home, ".claude", "hooks", "eventloom-hook.sh"), [], { input, ...options }),
    errors: () => {
      const file = path.join(home, ".local", "state", "omarchy", "agents", "eventloom-errors.log");
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    },
    settings: () => JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8")),
  };
}

const sessionStart = JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "SessionStart", source: "startup" });

test("install wires Claude, passes doctor, and the installed hook records an event", (t) => {
  const box = machine(t);
  const installed = box.install();
  assert.equal(installed.status, 0, installed.output);
  assert.match(installed.output, /ok +adapter: claude .*registered in settings\.json/);
  assert.match(installed.output, /install complete/);
  assert.deepEqual(Object.keys(box.settings().hooks), ["SessionStart", "SessionEnd", "PostToolUse", "PostToolUseFailure"]);

  // memory is off after install: an opening session is told nothing
  assert.deepEqual(box.hook(sessionStart), { status: 0, output: "" });
  // turned on, an opening session is handed the project's memory; every other hook stays silent
  box.eventloom(["config", "set", "memory", "on"]);
  const hooked = box.hook(sessionStart);
  assert.equal(hooked.status, 0);
  assert.match(hooked.output, /^Eventloom keeps a memory of what agents did in this project/);
  const used = box.hook(JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }));
  assert.deepEqual(used, { status: 0, output: "" }, "a hook must be silent");
  assert.match(box.eventloom(["tail", "--actor", "claude"]).output, /"type":"agent\.session\.started"/);
  assert.equal(box.eventloom(["verify"]).status, 0);
});

test("install takes no arguments, so --help does not install", (t) => {
  const box = machine(t);
  const refused = box.install({}, ["--help"]);
  assert.equal(refused.status, 1);
  assert.match(refused.output, /takes no arguments/);
  assert.equal(existsSync(path.join(box.home, ".local")), false);
});

test("installing twice changes nothing in settings.json", (t) => {
  const box = machine(t);
  box.install();
  const before = JSON.stringify(box.settings());
  assert.equal(box.install().status, 0);
  assert.equal(JSON.stringify(box.settings()), before);
});

test("an upgrade whose download fails says so and leaves the working install alone", (t) => {
  const box = machine(t);
  box.install();
  const failed = box.install({ env: { FAKE_NPM_FAIL: "1" } });
  assert.equal(failed.status, 1);
  assert.match(failed.output, /could not install @eventloom\/runtime; the existing install is unchanged/);
  assert.equal(box.eventloom(["append", "agent.note.added"]).status, 0);
});

test("install refuses a settings.json it cannot parse, and leaves it byte-identical", (t) => {
  const box = machine(t);
  const file = path.join(box.home, ".claude", "settings.json");
  const jsonc = '{\n  // mine\n  "model": "opus",\n}\n';
  writeFileSync(file, jsonc);
  const result = box.install();
  assert.equal(result.status, 1);
  assert.match(result.output, /not valid JSON.*left unchanged/);
  assert.match(result.output, /could not register the Claude hooks/);
  assert.equal(readFileSync(file, "utf8"), jsonc);
});

test("a launcher that cannot start is recorded privately, and the hook stays silent", (t) => {
  const box = machine(t);
  box.install();
  const errorLog = path.join(box.home, ".local", "state", "omarchy", "agents", "eventloom-errors.log");

  // a PATH with the launcher's shell tools but neither node nor bun
  const bare = path.join(box.home, "bare");
  mkdirSync(bare);
  for (const tool of ["sh", "dirname", "date", "mkdir", "head"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    symlinkSync(found, path.join(bare, tool));
  }
  const noRuntime = box.hook(sessionStart, { env: { PATH: bare } });
  assert.deepEqual(noRuntime, { status: 0, output: "" });
  assert.match(box.errors(), /\tlauncher\tneither bun nor node is on PATH/);
  assert.equal(statSync(errorLog).mode & 0o077, 0, "the error log is not readable by others");

  const entry = path.join(box.home, ".local", "lib", "eventloom", "lib", "eventloom.mjs");
  renameSync(entry, `${entry}.away`);
  assert.deepEqual(box.hook(sessionStart), { status: 0, output: "" });
  assert.match(box.errors(), /\tlauncher\t.*eventloom\.mjs is missing/);

  writeFileSync(entry, "this is not javascript (\n");
  assert.deepEqual(box.hook(sessionStart), { status: 0, output: "" });
  assert.match(box.errors(), /\tclaude-hook\tcrashed: SyntaxError/, "the error itself, not the stack location");

  writeFileSync(entry, 'throw new Error("runtime exploded");\n');
  assert.deepEqual(box.hook(sessionStart), { status: 0, output: "" });
  assert.match(box.errors(), /\tclaude-hook\tcrashed: Error: runtime exploded/, "not the echoed source line");
});

test("uninstall removes the install and its hooks, keeps the logs, and rejects unknown arguments", (t) => {
  const box = machine(t);
  box.install();
  box.hook(sessionStart);
  const logs = path.join(box.home, ".local", "state", "omarchy", "agents", "logs");

  for (const args of [["--help"], ["--purge", "--bogus"], ["", "--purge"]]) {
    const refused = box.uninstall(args);
    assert.equal(refused.status, 1, args.join(" "));
    assert.match(refused.output, /usage: uninstall\.sh \[--purge\]/);
  }
  assert.equal(existsSync(path.join(box.home, ".local", "bin", "eventloom")), true, "nothing was removed");

  assert.equal(box.uninstall([]).status, 0);
  assert.equal(existsSync(path.join(box.home, ".local", "bin", "eventloom")), false);
  assert.equal(existsSync(path.join(box.home, ".local", "lib", "eventloom")), false);
  assert.equal(existsSync(path.join(box.home, ".claude", "hooks", "eventloom-hook.sh")), false);
  assert.equal(box.settings().hooks, undefined);
  assert.equal(existsSync(logs), true);

  box.install();
  assert.equal(box.uninstall(["--purge"]).status, 0);
  assert.equal(existsSync(logs), false);
});

test("the plugin's setup installs once, then only when asked or when the checkout changed", (t) => {
  const box = machine(t);
  const stamp = path.join(box.home, ".local", "lib", "eventloom", ".installed-from");
  const check = box.pluginSetup(["--check"], { env: { FAKE_NPM_FAIL: "1" } });
  assert.equal(check.status, 3);
  assert.equal(existsSync(path.join(box.home, ".local")), false, "checking a fresh home does not install anything");

  const first = box.pluginSetup();
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /install complete/);
  assert.equal(box.eventloom(["append", "agent.note.added"]).status, 0);
  const installedFrom = readFileSync(stamp, "utf8");
  assert.deepEqual(box.pluginSetup(["--check"], { env: { FAKE_NPM_FAIL: "1" } }), { status: 0, output: installedFrom });

  // nothing to do: it must not even reach the package manager
  const second = box.pluginSetup([], { env: { FAKE_NPM_FAIL: "1" } });
  assert.deepEqual(second, { status: 0, output: "eventloom is up to date\n" });

  // as after `omarchy plugin update`: the stamp names another commit
  writeFileSync(stamp, "an older commit\n");
  assert.deepEqual(box.pluginSetup(["--check"], { env: { FAKE_NPM_FAIL: "1" } }), { status: 3, output: installedFrom });
  const failed = box.pluginSetup([], { env: { FAKE_NPM_FAIL: "1" } });
  assert.equal(failed.status, 1);
  assert.equal(readFileSync(stamp, "utf8"), "an older commit\n", "a failed install does not claim to be current");
  assert.equal(box.pluginSetup().status, 0);
  assert.equal(readFileSync(stamp, "utf8"), installedFrom);

  assert.match(box.pluginSetup(["--force"]).output, /install complete/);
});

// Runs plugin/open-tapestry.sh in its own process group, so that the server
// it leaves running can be stopped with it afterwards.
function openTapestry(t, box, port) {
  const opened = path.join(box.home, "opened");
  writeFileSync(path.join(box.tools, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${opened}'\n`, { mode: 0o755 });
  return (env = { EVENTLOOM_TAPESTRY_PORT: String(port) }) => new Promise((resolve) => {
    const child = spawn("sh", [path.join(REPO, "plugin", "open-tapestry.sh")], {
      detached: true,
      env: { HOME: box.home, PATH: box.basePath, ...env },
    });
    t.after(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* the group is already gone */ }
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (status) => resolve({
      status,
      output,
      opened: existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n") : [],
    }));
  });
}

test("opening the Tapestry hands the browser a private file, never an address with the key", async (t) => {
  const box = machine(t);
  box.install();
  const port = 21000 + (process.pid % 20000);
  const launchPage = path.join(box.home, ".local", "state", "omarchy", "agents", "tapestry", `launch-${port}.html`);
  const open = openTapestry(t, box, port);

  const first = await open();
  assert.equal(first.status, 0, first.output);
  assert.deepEqual(first.opened, [launchPage], "what the browser is given is a path");
  assert.equal(statSync(launchPage).mode & 0o777, 0o600);
  const key = /#key=([A-Za-z0-9_-]+)"/.exec(readFileSync(launchPage, "utf8"))[1];

  const weave = (headers) => fetch(`http://127.0.0.1:${port}/weave.json?days=1`, { headers });
  assert.equal((await weave({})).status, 401, "another user of the machine gets nothing");
  assert.equal((await weave({ authorization: `Bearer ${key}` })).status, 200);

  // a second call finds the server it started and opens the same page
  const second = await open();
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(second.opened, [launchPage, launchPage]);
  assert.equal(/#key=([A-Za-z0-9_-]+)"/.exec(readFileSync(launchPage, "utf8"))[1], key, "no second server was started");
});

test("opening the Tapestry uses the port the owner chose", async (t) => {
  const box = machine(t);
  box.install();
  const port = 24000 + (process.pid % 1000);
  assert.equal(box.eventloom(["config", "set", "tapestry_port", String(port)]).status, 0);
  const result = await openTapestry(t, box, port)({});
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.opened, [path.join(box.home, ".local", "state", "omarchy", "agents", "tapestry", `launch-${port}.html`)]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
});

// `script` gives the installer a terminal, which is when it asks.
const scriptTool = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" }).stdout.trim();

test("in a terminal the installer asks for the Tapestry port; without one it asks nothing", { skip: scriptTool ? false : "no `script` to provide a terminal" }, (t) => {
  const box = machine(t);
  const inTerminal = (answer) => spawnSync(scriptTool, ["-qec", `sh '${path.join(REPO, "install.sh")}'`, "/dev/null"], {
    input: `${answer}\n`, encoding: "utf8", env: { HOME: box.home, PATH: box.basePath },
  });
  const port = () => box.eventloom(["config", "get", "tapestry_port"]).output.trim();

  const silent = box.install();
  assert.equal(silent.status, 0, silent.output);
  assert.doesNotMatch(silent.output, /Tapestry port/);

  const chosen = inTerminal("5151\ny");
  assert.equal(chosen.status, 0, chosen.stdout);
  assert.match(chosen.stdout, /Tapestry port \[4747\]: /);
  assert.match(chosen.stdout, /the Tapestry will be served on port 5151/);
  assert.equal(port(), "5151");
  assert.match(chosen.stdout, /Turn on shared memory\? [^\n]*\n[^\n]*\[y\/N\]: /);
  assert.match(chosen.stdout, /memory is on/);
  assert.equal(box.eventloom(["config", "get", "memory"]).output.trim(), "on");

  const kept = inTerminal("");
  assert.match(kept.stdout, /Tapestry port \[5151\]: /);
  assert.equal(port(), "5151", "enter keeps what was there");

  // sealed mode is offered, explained when accepted, and never set up from here
  assert.match(kept.stdout, /Enable sealed mode\? .* \[y\/N\]: /);
  assert.match(kept.stdout, /sealed mode left off \(turn it on later with: eventloom seal enable\)/);
  const wanted = inTerminal("\ny"); // port as it is, then sealed mode yes (memory is on, so not asked again)
  assert.match(wanted.stdout, /sudo sh .*\.local\/lib\/eventloom\/seal\/setup\.sh/);
  assert.match(box.eventloom(["seal", "status"]).output, /^sealed mode is off/);

  const refused = inTerminal("80");
  assert.equal(refused.status, 0, "a bad answer does not fail the install");
  assert.match(refused.stdout, /kept port 5151/);
  assert.equal(port(), "5151");
});

test("opening the Tapestry refuses a port held by something else", async (t) => {
  const box = machine(t);
  box.install();
  const port = 22000 + (process.pid % 20000);
  const stranger = createServer((_req, res) => res.end("not a tapestry")).listen(port, "127.0.0.1");
  await new Promise((resolve) => stranger.once("listening", resolve));
  t.after(() => stranger.close());

  const result = await openTapestry(t, box, port)();
  assert.equal(result.status, 1);
  assert.match(result.output, new RegExp(`port ${port} is held by a server this cannot use.*eventloom config set tapestry_port <n>`));
  assert.deepEqual(result.opened, []);
});

test("Codex install is reversible, preserves other hooks and config, and respects custom CODEX_HOME", (t) => {
  const box = machine(t);
  const codexHome = path.join(box.home, "custom-codex");
  mkdirSync(codexHome);
  const settings = path.join(codexHome, "hooks.json");
  const original = { description: "my hooks", hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }] } };
  writeFileSync(settings, JSON.stringify(original));
  writeFileSync(path.join(codexHome, "config.toml"), 'model = "my-model"\n');
  const options = { env: { CODEX_HOME: codexHome } };
  const installed = box.install(options);
  assert.equal(installed.status, 0, installed.output);
  assert.match(installed.output, /review and trust Eventloom's hooks in Codex \/hooks/);
  assert.match(installed.output, /ok +adapter: codex .*registered in hooks.json/);
  const once = readFileSync(settings, "utf8");
  assert.equal(box.install(options).status, 0);
  assert.equal(readFileSync(settings, "utf8"), once);
  assert.equal(readFileSync(path.join(codexHome, "config.toml"), "utf8"), 'model = "my-model"\n');
  assert.equal(JSON.parse(readFileSync(`${settings}.eventloom-backup`, "utf8")).description, original.description);
  const removed = box.sh(path.join(REPO, "uninstall.sh"), [], options);
  assert.equal(removed.status, 0, removed.output);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), original);
  assert.equal(existsSync(path.join(codexHome, "hooks/eventloom-codex-hook.sh")), false);
});

test("Codex hook records metadata, opts into shared memory, and attributes its notes", (t) => {
  const box = machine(t);
  mkdirSync(path.join(box.home, ".codex"));
  assert.equal(box.install().status, 0);
  const script = path.join(box.home, ".codex/hooks/eventloom-codex-hook.sh");
  const hook = (value, env = {}) => box.sh(script, [], { input: JSON.stringify(value), env });
  const start = { session_id: "codex-session", cwd: box.home, hook_event_name: "SessionStart", source: "startup" };
  assert.deepEqual(hook(start), { status: 0, output: "{}\n" });
  box.eventloom(["note", "--actor", "claude", "--session", "old", "--cwd", box.home], { input: "Prepared the shared rollout plan." });
  box.eventloom(["config", "set", "memory", "on"]);
  const brief = JSON.parse(hook(start).output).hookSpecificOutput;
  assert.equal(brief.hookEventName, "SessionStart");
  assert.match(brief.additionalContext, /Prepared the shared rollout plan/);
  assert.match(brief.additionalContext, /eventloom note --actor codex --session 'codex-session'/);
  const noteLine = brief.additionalContext.split("\n").find((line) => line.trim().startsWith("eventloom note"));
  const noteScript = path.join(box.home, "codex-note.sh");
  writeFileSync(noteScript, `${noteLine}\nRecorded the Codex rollout.\nEOF\n`);
  const noted = box.sh(noteScript, [], { env: { PATH: `${path.join(box.home, ".local/bin")}:${box.basePath}` } });
  assert.equal(noted.status, 0, noted.output);
  const recordedNote = box.eventloom(["tail", "--limit", "50", "--actor", "codex"]).output.split("\n").filter(Boolean).map(JSON.parse)
    .find((event) => event.type === "agent.reply.summarized");
  assert.equal(recordedNote.payload.session_id, start.session_id);
  assert.equal(recordedNote.payload.summary, "Recorded the Codex rollout.");
  const input = { session_id: start.session_id, cwd: box.home, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "PRIVATE_ARGUMENT" }, tool_response: { exit_code: 7, output: "PRIVATE_OUTPUT" } };
  assert.deepEqual(hook(input), { status: 0, output: "{}\n" });
  const tail = box.eventloom(["tail", "--limit", "50", "--actor", "codex"]).output;
  assert.match(tail, /agent.memory.recalled/);
  assert.match(tail, /agent.tool.failed/);
  assert.doesNotMatch(tail, /PRIVATE_/);
  const before = tail;
  assert.deepEqual(hook(input, { EVENTLOOM_DISABLE: "1" }), { status: 0, output: "" });
  assert.equal(box.eventloom(["tail", "--limit", "50", "--actor", "codex"]).output, before);
  assert.deepEqual(hook(start, { EVENTLOOM_MODE: "metadata" }), { status: 0, output: "{}\n" });
  assert.deepEqual(hook(start, { EVENTLOOM_MEMORY: "0" }), { status: 0, output: "{}\n" });
  assert.equal(box.eventloom(["verify"]).status, 0);
});

test("Codex refuses invalid hooks.json and retains a referenced script on uninstall", (t) => {
  const box = machine(t);
  const codexHome = path.join(box.home, ".codex");
  mkdirSync(codexHome);
  const settings = path.join(codexHome, "hooks.json");
  const invalid = '{ "hooks": /* keep my file */';
  writeFileSync(settings, invalid);
  const refused = box.install();
  assert.equal(refused.status, 1);
  assert.equal(readFileSync(settings, "utf8"), invalid);
  assert.match(refused.output, /not valid JSON.*left unchanged/);
  assert.equal(box.uninstall([]).status, 0);
  assert.equal(existsSync(path.join(codexHome, "hooks/eventloom-codex-hook.sh")), true);
  assert.equal(readFileSync(settings, "utf8"), invalid);
});

test("Codex recording failures stay private and never fail the agent", (t) => {
  const box = machine(t);
  mkdirSync(path.join(box.home, ".codex"));
  box.install();
  const script = path.join(box.home, ".codex/hooks/eventloom-codex-hook.sh");
  assert.deepEqual(box.sh(script, [], { input: '{"PRIVATE_CONTENT":' }), { status: 0, output: "" });
  assert.match(box.errors(), /codex-hook\tCodex hook input is not valid JSON/);
  assert.doesNotMatch(box.errors(), /PRIVATE_CONTENT/);
  const entry = path.join(box.home, ".local/lib/eventloom/lib/eventloom.mjs");
  writeFileSync(entry, 'throw new Error("runtime failed");');
  assert.deepEqual(box.sh(script, [], { input: "{}" }), { status: 0, output: "" });
  assert.match(box.errors(), /codex-hook\tcrashed: Error: runtime failed/);
});

test("OpenCode plugin installs without editing config or other plugins, and uninstalls cleanly", async (t) => {
  const box = machine(t);
  const configRoot = path.join(box.home, "custom-config");
  const opencode = path.join(configRoot, "opencode");
  mkdirSync(path.join(opencode, "plugins"), { recursive: true });
  const config = '{ /* JSONC belongs to OpenCode */ "model": "mine" }';
  writeFileSync(path.join(opencode, "opencode.json"), config);
  writeFileSync(path.join(opencode, "plugins/mine.js"), "export const Mine = async () => ({});");
  const options = { env: { XDG_CONFIG_HOME: configRoot } };
  const installed = box.install(options);
  assert.equal(installed.status, 0, installed.output);
  assert.match(installed.output, /opencode adapter installed/);
  assert.match(installed.output, /ok +adapter: opencode/);
  assert.equal(readFileSync(path.join(opencode, "opencode.json"), "utf8"), config);
  const loader = path.join(opencode, "plugins/omarchy-eventloom.js");
  assert.ok(existsSync(loader));
  // Exercise the copied loader with the installed library, not an SDK stub.
  const probe = path.join(box.home, "probe-opencode.mjs");
  writeFileSync(probe, `import {Eventloom} from ${JSON.stringify('file://' + loader)};
const hooks = await Eventloom({directory:${JSON.stringify(box.home)}});
await hooks.event({event:{type:"session.created",properties:{info:{id:"open-session"}}}});
const system={system:[]}; await hooks["experimental.chat.system.transform"]({sessionID:"open-session"},system);
if(system.system.length)throw Error("memory must default off");
await hooks.dispose();
`);
  const probeResult = spawnSync(process.execPath, [probe], { env: { HOME: box.home, PATH: box.basePath, ...options.env }, encoding: "utf8" });
  assert.equal(probeResult.status, 0, probeResult.stderr);
  const tail = () => box.eventloom(["tail", "--limit", "50", "--actor", "opencode"]).output;
  await until(() => tail().includes("agent.session.completed"));
  assert.match(tail(), /open-session/);
  assert.equal(box.sh(path.join(REPO, "uninstall.sh"), [], options).status, 0);
  assert.equal(existsSync(loader), false);
  assert.equal(existsSync(path.join(opencode, "plugins/mine.js")), true);
  assert.equal(readFileSync(path.join(opencode, "opencode.json"), "utf8"), config);
});

test("OpenCode installer refuses an unrelated file at its adapter path", (t) => {
  const box = machine(t);
  const plugins = path.join(box.home, ".config/opencode/plugins");
  mkdirSync(plugins, { recursive: true });
  const file = path.join(plugins, "omarchy-eventloom.js");
  const original = "export const UserPlugin = async () => ({});";
  writeFileSync(file, original);
  const installed = box.install();
  assert.equal(installed.status, 1);
  assert.match(installed.output, /already exists.*left unchanged/);
  assert.equal(readFileSync(file, "utf8"), original);
  box.uninstall([]);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("Pi installs into its custom agent directory and preserves other extensions and settings", async (t) => {
  const box = machine(t);
  const agentDir = path.join(box.home, "custom-pi");
  mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  const settings = '{"model":"my-model"}';
  writeFileSync(path.join(agentDir, "settings.json"), settings);
  writeFileSync(path.join(agentDir, "extensions/mine.js"), "export default function(){};");
  const options = { env: { PI_CODING_AGENT_DIR: agentDir } };
  const installed = box.install(options);
  assert.equal(installed.status, 0, installed.output);
  assert.match(installed.output, /pi adapter installed/);
  assert.match(installed.output, /ok +adapter: pi/);
  const extension = path.join(agentDir, "extensions/omarchy-eventloom.js");
  const probe = path.join(box.home, "probe-pi.mjs");
  writeFileSync(probe, `import install from ${JSON.stringify('file://' + extension)};
const handlers=new Map();await install({on:(n,h)=>handlers.set(n,h)});
const ctx={cwd:${JSON.stringify(box.home)},sessionManager:{getSessionId:()=>"pi-session"}};
await handlers.get("session_start")({reason:"startup"},ctx);
if(await handlers.get("before_agent_start")({},ctx))throw Error("memory defaults off");
await handlers.get("session_shutdown")({reason:"quit"},ctx);
`);
  const probeResult = spawnSync(process.execPath, [probe], { env: { HOME: box.home, PATH: box.basePath, ...options.env }, encoding: "utf8" });
  assert.equal(probeResult.status, 0, probeResult.stderr);
  const tail = () => box.eventloom(["tail", "--limit", "50", "--actor", "pi"]).output;
  await until(() => tail().includes("agent.session.completed"));
  assert.match(tail(), /pi-session/);
  assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), settings);
  assert.equal(box.sh(path.join(REPO, "uninstall.sh"), [], options).status, 0);
  assert.equal(existsSync(extension), false);
  assert.equal(existsSync(path.join(agentDir, "extensions/mine.js")), true);
  assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), settings);
});

test("native hooks install, record privately, inject opted-in memory, and uninstall without removing user hooks", (t) => {
  const box = machine(t);
  const homes = { copilot: ".copilot", gemini: ".gemini", crush: ".config/crush", grok: ".grok", agy: ".gemini/antigravity-cli", muse: ".config/muse", "cursor-agent": ".cursor" };
  const configs = { copilot: ".copilot/hooks/omarchy-eventloom.json", gemini: ".gemini/settings.json", crush: ".config/crush/crush.json", grok: ".grok/hooks/omarchy-eventloom.json", agy: ".gemini/config/hooks.json", muse: ".config/muse/settings.json", "cursor-agent": ".cursor/hooks.json" };
  const originals = {};
  for (const agent of Object.keys(homes)) {
    mkdirSync(path.join(box.home, homes[agent]), { recursive: true });
    const original = agent === "agy" ? { mine: { SessionStart: [{ command: "my-init" }] } }
      : { ...(["copilot", "cursor-agent"].includes(agent) ? { version: 1 } : agent === "muse" ? { schema_version: 1 } : {}), hooks: { PreToolUse: ["grok", "gemini", "muse"].includes(agent) ? [{ hooks: [{ type: "command", command: "my-tool-hook" }] }] : [{ command: "my-tool-hook" }] } };
    // Gemini's event is BeforeTool; this separate event still must survive.
    originals[agent] = original;
    const file = path.join(box.home, configs[agent]);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(original));
  }
  const installed = box.install();
  assert.equal(installed.status, 0, installed.output);
  const script = path.join(box.home, ".local/share/eventloom/hooks/eventloom-native-hook.sh");
  const fire = (agent, event, data = {}, env = {}) => box.sh(script, [agent, event], { env, input: JSON.stringify({
    session_id: "native-session", sessionId: "native-session", conversationId: "native-session", conversation_id: "native-session", cwd: "/work", workspacePaths: ["/work"],
    tool_name: "bash", toolName: "bash", toolCall: { name: "bash", args: { command: "PRIVATE_COMMAND" } },
    tool_input: { command: "PRIVATE_COMMAND" }, toolInput: { command: "PRIVATE_COMMAND" }, ...data,
  }) });
  for (const [agent, profile] of Object.entries(NATIVE_HOOKS)) {
    const event = profile.events[0];
    assert.deepEqual(JSON.parse(fire(agent, event).output), nativeHookResponse(agent, event));
    assert.match(box.eventloom(["tail", "--actor", agent]).output, /native-session/);
    assert.deepEqual(JSON.parse(fire(agent, "PreToolUse", {}, { EVENTLOOM_DISABLE: "1" }).output), nativeHookResponse(agent, "PreToolUse"));
  }
  box.eventloom(["config", "set", "memory", "on"]);
  for (const agent of ["copilot", "gemini", "agy", "muse"]) {
    const result = fire(agent, "SessionStart");
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Eventloom keeps a memory/);
    assert.match(result.output, /eventloom note --actor/);
  }
  // Malformed and early CLI crashes cannot break Copilot's fail-closed hook
  // gate or leave Antigravity without its required neutral decision.
  const malformed = box.sh(script, ["copilot", "PreToolUse"], { input: '{"PRIVATE_BROKEN"' });
  assert.deepEqual(malformed, { status: 0, output: "{}\n" });
  assert.doesNotMatch(box.errors(), /PRIVATE_/);
  assert.equal(box.eventloom(["verify"]).status, 0);
  assert.equal(box.uninstall([]).status, 0);
  assert.equal(existsSync(script), false);
  for (const agent of Object.keys(homes)) {
    assert.deepEqual(JSON.parse(readFileSync(path.join(box.home, configs[agent]), "utf8")), originals[agent]);
  }
});

test("native hook config parse failures preserve bytes and leave a neutral wrapper after uninstall", (t) => {
  const box = machine(t);
  const dir = path.join(box.home, ".config/crush");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "crush.json"), original = '{ // user jsonc\n"theme":"mine"\n}';
  writeFileSync(file, original);
  const installed = box.install();
  assert.equal(installed.status, 1);
  assert.match(installed.output, /left unchanged/);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(box.uninstall([]).status, 0);
  const script = path.join(box.home, ".local/share/eventloom/hooks/eventloom-native-hook.sh");
  assert.deepEqual(box.sh(script, ["agy", "PreToolUse"], { input: "{}" }), { status: 0, output: '{"decision":"allow"}\n' });
});

test("agents setup connects agents added later without downloads or invoking launchers", (t) => {
  const box = machine(t);
  assert.equal(box.install().status, 0);
  for (const dir of [".codex", ".omp/agent", ".config/opencode", ".pi/agent", ".gemini"]) mkdirSync(path.join(box.home, dir), { recursive: true });
  for (const agent of ["codex", "omp", "opencode", "pi", "gemini"]) writeFileSync(path.join(box.tools, agent), '#!/bin/sh\ntouch "$HOME/launcher-ran"\nexit 99\n', { mode: 0o755 });
  const result = box.eventloom(["agents", "setup", "--json"], { env: { FAKE_NPM_FAIL: "1" } });
  assert.equal(result.status, 0, result.output);
  const report = JSON.parse(result.output);
  assert.equal(report.changed, true);
  for (const agent of ["codex", "omp", "opencode", "pi", "gemini"]) assert.equal(report.agents.find(item => item.agent === agent).status, "registered");
  assert.equal(existsSync(path.join(box.home, "launcher-ran")), false);
  const config = path.join(box.home, ".codex/hooks.json"), loader = path.join(box.home, ".config/opencode/plugins/omarchy-eventloom.js");
  const before = [statSync(config).mtimeMs, statSync(loader).mtimeMs];
  const again = box.eventloom(["agents", "setup", "--json", "--quiet"]);
  assert.deepEqual(again, { status: 0, output: "" });
  assert.deepEqual([statSync(config).mtimeMs, statSync(loader).mtimeMs], before);
  assert.match(box.eventloom(["agents", "setup"]).output, /Action: codex: review and trust/);
  assert.equal(box.eventloom(["doctor"]).status, 0);
  assert.equal(box.eventloom(["agents", "bogus"]).status, 1);
});

test("agents setup preserves disabled and restricted registrations while adding absent events", (t) => {
  const box = machine(t);
  mkdirSync(path.join(box.home, ".codex"));
  mkdirSync(path.join(box.home, ".gemini"));
  assert.equal(box.install().status, 0);
  const codex = path.join(box.home, ".codex/hooks.json"), gemini = path.join(box.home, ".gemini/settings.json");
  const settings = JSON.parse(readFileSync(codex));
  settings.hooks.SessionStart[0].enabled = false;
  settings.hooks.PreToolUse[0].matcher = "Bash";
  settings.hooks.PostToolUse[0].hooks[0].enabled = false;
  settings.hooks.Stop = [{ hooks: [{ type: "command", command: "my-own-hook" }] }];
  const missing = settings.hooks.SessionEnd;
  delete settings.hooks.SessionEnd;
  writeFileSync(codex, JSON.stringify(settings));
  const native = JSON.parse(readFileSync(gemini));
  native.hooks.SessionStart[0].hooks[0].enabled = false;
  const nativeBytes = JSON.stringify(native);
  writeFileSync(gemini, nativeBytes);
  const result = box.eventloom(["agents", "setup", "--json"]);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(JSON.parse(readFileSync(codex)), { ...settings, hooks: { ...settings.hooks, SessionEnd: missing } });
  assert.equal(readFileSync(gemini, "utf8"), nativeBytes);
  const report = JSON.parse(result.output);
  assert.match(report.agents.find(item => item.agent === "codex").attention, /left unchanged/);
  assert.match(report.agents.find(item => item.agent === "gemini").attention, /left unchanged/);
});

test("agents setup isolates malformed configuration and retries after it is fixed", (t) => {
  const box = machine(t);
  assert.equal(box.install().status, 0);
  for (const dir of [".codex", ".gemini"]) mkdirSync(path.join(box.home, dir));
  const file = path.join(box.home, ".codex/hooks.json"), original = '{ "private": "do-not-echo", // not JSON\n}';
  writeFileSync(file, original);
  const result = box.eventloom(["agents", "setup", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.doesNotMatch(result.output, /do-not-echo/);
  const report = JSON.parse(result.output);
  assert.equal(report.agents.find(item => item.agent === "codex").status, "error");
  assert.equal(report.agents.find(item => item.agent === "gemini").status, "registered");
  writeFileSync(file, "{}");
  assert.equal(box.eventloom(["agents", "setup"]).status, 0);
  assert.ok(JSON.parse(readFileSync(file)).hooks.SessionStart);
});
