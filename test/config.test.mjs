// The settings file, and the tapestry port it remembers.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getSetting, setSetting, tapestryPort } from "../lib/config.mjs";
import { tempDir, until } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../lib/eventloom.mjs", import.meta.url));
const freePort = (offset) => 23000 + offset * 1000 + (process.pid % 1000);

test("a setting is its line in the file, else its default, and bad values are errors", (t) => {
  const file = path.join(tempDir(t, "config"), "eventloom", "config");
  assert.equal(getSetting("tapestry_port", file), 4747);

  assert.equal(setSetting("tapestry_port", "5050", file), 5050);
  assert.equal(readFileSync(file, "utf8"), "tapestry_port=5050\n");

  // other lines are the owner's and stay; a repeated key means the last one
  writeFileSync(file, "# mine\nfuture_key = kept\n tapestry_port = 6000 \ntapestry_port=6001\n");
  assert.equal(getSetting("tapestry_port", file), 6001);
  setSetting("tapestry_port", 6002, file);
  assert.equal(readFileSync(file, "utf8"), "# mine\nfuture_key = kept\ntapestry_port=6002\n");

  for (const bad of ["80", "1023", "65536", "5050.5", "abc", "", "-1", "0x1f90"]) {
    assert.throws(() => setSetting("tapestry_port", bad, file), /a port is a whole number from 1024 to 65535/, bad);
  }
  assert.throws(() => setSetting("sealed", "no", file), /"sealed" is not a setting/);
  writeFileSync(file, "tapestry_port=99\n");
  assert.throws(() => getSetting("tapestry_port", file), new RegExp(`${file}: tapestry_port: a port is a whole number`));
});

test("the tapestry's port is the flag, else the environment, else the setting, else 4747", (t) => {
  const file = path.join(tempDir(t, "config"), "config");
  assert.equal(tapestryPort({ env: {}, file }), 4747);
  setSetting("tapestry_port", 5050, file);
  assert.equal(tapestryPort({ env: {}, file }), 5050);
  assert.equal(tapestryPort({ env: { EVENTLOOM_TAPESTRY_PORT: "6060" }, file }), 6060);
  assert.equal(tapestryPort({ flag: 7070, env: { EVENTLOOM_TAPESTRY_PORT: "6060" }, file }), 7070);
  assert.throws(() => tapestryPort({ env: { EVENTLOOM_TAPESTRY_PORT: "nope" }, file }), /EVENTLOOM_TAPESTRY_PORT: a port is a whole number from 1 to 65535/);
});

function sandbox(t) {
  const home = tempDir(t, "config-cli");
  const logs = path.join(home, "state", "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, EVENTLOOM_LOG_DIR: logs };
  const run = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...env, ...extra } });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { home, env, run, config: path.join(home, ".config", "eventloom", "config"), launchPage: (port) => path.join(home, "state", "tapestry", `launch-${port}.html`) };
}

test("eventloom config lists, reads and changes settings", (t) => {
  const { run, config, home } = sandbox(t);
  assert.equal(run(["config"]).stdout, "tapestry_port=4747  # where the Tapestry is served\n");
  assert.equal(existsSync(config), false, "reading creates nothing");
  assert.equal(run(["config", "set", "tapestry_port", "5050"]).stdout, "tapestry_port=5050\n");
  assert.equal(run(["config", "get", "tapestry_port"]).stdout, "5050\n");
  assert.equal(readFileSync(config, "utf8"), "tapestry_port=5050\n");

  const elsewhere = path.join(home, "xdg");
  assert.equal(run(["config", "get", "tapestry_port"], { XDG_CONFIG_HOME: elsewhere }).stdout, "4747\n", "XDG_CONFIG_HOME is honoured");

  for (const [args, message] of [
    [["config", "set", "tapestry_port", "80"], /a port is a whole number from 1024 to 65535 \(got "80"\)/],
    [["config", "get", "nope"], /"nope" is not a setting \(there is: tapestry_port\)/],
    [["config", "set", "tapestry_port"], /usage: eventloom config/],
    [["config", "unset", "tapestry_port"], /usage: eventloom config/],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, message);
  }
});

test("the tapestry is served on the remembered port, and doctor says where", async (t) => {
  const { env, run, launchPage } = sandbox(t);
  const [chosen, held] = [freePort(0), freePort(1)];
  run(["config", "set", "tapestry_port", String(chosen)]);
  assert.match(run(["doctor"]).stdout, new RegExp(`ok +tapestry +port ${chosen}, not running`));

  const server = spawn(process.execPath, [CLI, "tapestry", "--demo"], { env, stdio: "ignore" });
  t.after(() => server.kill());
  await until(() => existsSync(launchPage(chosen)));
  assert.equal((await fetch(`http://127.0.0.1:${chosen}/`)).status, 200);
  assert.match(run(["doctor"]).stdout, new RegExp(`ok +tapestry +port ${chosen}, running`));

  const stranger = createServer((_req, res) => res.end("not a tapestry")).listen(held, "127.0.0.1");
  await new Promise((resolve) => stranger.once("listening", resolve));
  t.after(() => stranger.close());
  const taken = run(["doctor"], { EVENTLOOM_TAPESTRY_PORT: String(held) });
  assert.match(taken.stdout, new RegExp(`warn +tapestry +port ${held} is held by another program; choose another with: eventloom config set tapestry_port <n>`));
  assert.equal(taken.status, 0, "a warning, not a failure");

  writeFileSync(path.join(env.HOME, ".config", "eventloom", "config"), "tapestry_port=seven\n");
  const broken = run(["doctor"]);
  assert.match(broken.stdout, /fail +tapestry +.*tapestry_port: a port is a whole number/);
  assert.match(run(["tapestry", "--demo"]).stderr, /tapestry_port: a port is a whole number/);
});
