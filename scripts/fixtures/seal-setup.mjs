// Launched only inside the disposable root namespace by seal-setup.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chownSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SETUP = process.env.EVENTLOOM_TEST_SEAL_SETUP ?? fileURLToPath(new URL("../../seal/setup.sh", import.meta.url));
// Fail before any mutation or cleanup if launched outside the test sandbox.
assert.equal(process.getuid(), 0, "fixture requires namespace root");
assert.ok(process.env.EVENTLOOM_SEAL_SETUP_FIXTURE, "fixture requires an explicit sandbox");
assert.match(readFileSync("/proc/self/uid_map", "utf8"), /^\s*0\s+[1-9][0-9]*\s+1\s*$/m, "root must map to an unprivileged host UID");
for (const dir of ["/var/lib", "/usr/local/libexec", "/etc/sudoers.d"]) {
  assert.equal(readFileSync(`${dir}/.eventloom-test-sandbox`, "utf8"), process.env.EVENTLOOM_SEAL_SETUP_FIXTURE, `${dir} must be a disposable bind mount`);
}
const DIR = "/var/lib/eventloom-seal";
const FILE = `${DIR}/1000.evtseal`;
const OUTSIDE = "/var/lib/outside";
const HEADER = "eventloom-seal 1 uid=1000 log=/home/alice/.local/state/omarchy/agents/logs\n";
const scenario = process.argv[2];
const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", SUDO_USER: "alice", SUDO_UID: "1000" };
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", env, ...options });
const setup = (...args) => run("sh", [SETUP, ...args]);
const seal = (command, args) => run("setpriv", ["--reuid=999", "--regid=999", "--clear-groups", "--", command, ...args]);
const pass = (result) => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const directory = () => {
  mkdirSync(DIR, { mode: 0o711 });
  chownSync(DIR, 999, 0); // the vulnerable installation's ownership
};
const protectedDirectory = () => {
  const stat = lstatSync(DIR);
  assert.equal(stat.uid, 0);
  assert.equal(stat.gid, 0);
  assert.equal(stat.mode & 0o777, 0o711);
  assert.notEqual(seal("touch", [`${DIR}/planted`]).status, 0, "seal account cannot create entries");
};

try {
  if (scenario === "lifecycle" || scenario === "migration") {
    if (scenario === "migration") {
      directory();
      writeFileSync(FILE, HEADER);
      chownSync(FILE, 999, 1000);
      chmodSync(FILE, 0o640);
    }
    pass(setup());
    protectedDirectory();
    const stat = lstatSync(FILE);
    assert.equal(stat.uid, 999);
    assert.equal(stat.gid, 1000);
    assert.equal(stat.mode & 0o777, 0o640);
    assert.equal(readFileSync(FILE, "utf8"), HEADER);
    const hash = `sha256:${"a".repeat(64)}`;
    pass(seal("/usr/local/libexec/eventloom-seal", ["head", "2026-10-20", "10", hash]));
    const sealed = readFileSync(FILE, "utf8");
    assert.equal(sealed.trimEnd().split("\n").length, 2, "existing-file appends still work");
    pass(setup());
    assert.equal(readFileSync(FILE, "utf8"), sealed, "rerunning setup preserves history");
    assert.notEqual(seal("rm", [FILE]).status, 0, "seal account cannot unlink its file");
    const mismatch = setup("--log-dir", "/different/logs");
    assert.notEqual(mismatch.status, 0);
    assert.equal(readFileSync(FILE, "utf8"), sealed);
    pass(setup("--remove"));
    assert.equal(readFileSync(FILE, "utf8"), sealed, "remove retains protected history");
    assert.equal(existsSync("/etc/sudoers.d/eventloom-seal-alice"), false);
    pass(setup());
    pass(setup("--remove", "--purge"));
    assert.equal(existsSync(FILE), false);
  } else if (scenario === "directory-link") {
    mkdirSync(OUTSIDE);
    writeFileSync(`${OUTSIDE}/1000.evtseal`, HEADER);
    symlinkSync(OUTSIDE, DIR);
    const before = lstatSync(OUTSIDE);
    for (const args of [[], ["--remove", "--purge"]]) {
      const result = setup(...args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not be a symbolic link/);
      assert.equal(readFileSync(`${OUTSIDE}/1000.evtseal`, "utf8"), HEADER);
      assert.equal(lstatSync(OUTSIDE).uid, before.uid);
      assert.equal(lstatSync(OUTSIDE).mode, before.mode);
    }
  } else {
    directory();
    if (scenario === "dangling-link") {
      pass(seal("ln", ["-s", OUTSIDE, FILE]));
    } else if (scenario === "live-link" || scenario === "hard-link") {
      writeFileSync(OUTSIDE, HEADER);
      chmodSync(OUTSIDE, 0o600);
      if (scenario === "live-link") pass(seal("ln", ["-s", OUTSIDE, FILE]));
      else {
        chownSync(OUTSIDE, 999, 999);
        pass(seal("ln", [OUTSIDE, FILE]));
      }
    } else if (scenario === "fifo") {
      pass(seal("mkfifo", [FILE]));
    } else {
      throw new Error(`unknown scenario: ${scenario}`);
    }
    const before = existsSync(OUTSIDE) ? lstatSync(OUTSIDE) : null;
    const result = setup();
    assert.notEqual(result.status, 0, `unsafe paths must be refused (outside target exists=${existsSync(OUTSIDE)}, uid=${existsSync(OUTSIDE) ? lstatSync(OUTSIDE).uid : "absent"})`);
    assert.match(result.stderr, /must not be a symbolic link|must not have hard links|must be a regular file/);
    protectedDirectory();
    if (scenario === "dangling-link") assert.equal(existsSync(OUTSIDE), false, "root did not create the attacker's target");
    if (scenario === "live-link" || scenario === "hard-link") {
      assert.equal(readFileSync(OUTSIDE, "utf8"), HEADER);
      assert.equal(lstatSync(OUTSIDE).uid, before.uid, "root did not transfer ownership of the target");
      assert.equal(lstatSync(OUTSIDE).gid, before.gid);
      assert.equal(lstatSync(OUTSIDE).mode & 0o777, 0o600);
    }
  }
  console.log(`${scenario}: scenario passed`);
} finally {
  // Files owned by namespace-only UIDs cannot be cleaned up by the parent.
  for (const dir of ["/var/lib", "/usr/local/libexec", "/etc/sudoers.d"]) {
    for (const name of readdirSync(dir)) {
      if (name !== ".eventloom-test-sandbox") rmSync(`${dir}/${name}`, { recursive: true, force: true });
    }
  }
}
