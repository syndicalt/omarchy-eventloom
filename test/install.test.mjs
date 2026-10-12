// Runs the shell entry points for real: install.sh, the launcher, the Claude
// hook and uninstall.sh, against a throwaway HOME. `npm` is a stand-in that
// copies this checkout's node_modules, so no network is involved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  const hooked = box.hook(sessionStart);
  assert.deepEqual(hooked, { status: 0, output: "" }, "a hook must be silent");
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
