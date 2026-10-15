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
import { tempDir } from "./helpers.mjs";

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

  const first = box.pluginSetup();
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /install complete/);
  assert.equal(box.eventloom(["append", "agent.note.added"]).status, 0);
  const installedFrom = readFileSync(stamp, "utf8");

  // nothing to do: it must not even reach the package manager
  const second = box.pluginSetup([], { env: { FAKE_NPM_FAIL: "1" } });
  assert.deepEqual(second, { status: 0, output: "eventloom is up to date\n" });

  // as after `omarchy plugin update`: the stamp names another commit
  writeFileSync(stamp, "an older commit\n");
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
