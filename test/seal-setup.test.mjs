// Exercise the actual root setup script with distinct root, owner and seal
// identities. User/mount namespaces keep every write in disposable fixtures.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.mjs";

const FIXTURE = fileURLToPath(new URL("../scripts/fixtures/seal-setup.mjs", import.meta.url));
const namespace = ["--user", "--map-auto", "--map-root-user", "--"];
const probe = spawnSync("unshare", [...namespace, "bwrap", "--ro-bind", "/", "/", "--", "true"], { encoding: "utf8" });
const unavailable = probe.status !== 0 && `isolated root setup requires unshare/subuid mappings and bwrap: ${probe.error?.message ?? probe.stderr.trim()}`;

for (const scenario of ["lifecycle", "migration", "dangling-link", "live-link", "hard-link", "fifo", "directory-link"]) {
  test(`root seal setup: ${scenario}`, { skip: unavailable || false }, (t) => {
    const dir = tempDir(t, "root-seal-setup");
    for (const name of ["var-lib", "libexec", "sudoers"]) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, ".eventloom-test-sandbox"), dir);
    }
    writeFileSync(path.join(dir, "passwd"), "root:x:0:0:root:/root:/bin/sh\nalice:x:1000:1000:Alice:/home/alice:/bin/sh\neventloom-seal:x:999:999:Seal:/var/lib/eventloom-seal:/usr/bin/nologin\n");
    writeFileSync(path.join(dir, "group"), "root:x:0:\nalice:x:1000:\neventloom-seal:x:999:\n");
    const args = [...namespace, "bwrap", "--die-with-parent", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--cap-add", "ALL", "--ro-bind", "/", "/"];
    for (const [source, target] of [["var-lib", "/var/lib"], ["libexec", "/usr/local/libexec"], ["sudoers", "/etc/sudoers.d"]]) {
      args.push("--bind", path.join(dir, source), target);
    }
    for (const name of ["passwd", "group"]) args.push("--ro-bind", path.join(dir, name), `/etc/${name}`);
    args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--setenv", "EVENTLOOM_SEAL_SETUP_FIXTURE", dir, "--", process.execPath, FIXTURE, scenario);
    const result = spawnSync("unshare", args, { encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /scenario passed/);
  });
}
