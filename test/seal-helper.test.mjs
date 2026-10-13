// The seal helper, run as the current user against a scratch directory. In
// use it is owned by root and run through sudo as another user; what is
// tested here is what it accepts, what it refuses and what it writes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.mjs";

const SOURCE = fileURLToPath(new URL("../seal/eventloom-seal", import.meta.url));
const sha = (text) => createHash("sha256").update(text).digest("hex");
const HASH = `sha256:${sha("an event")}`;
const UID = process.getuid();

// The helper with its one path pointed at a scratch directory.
function helper(t, { setUp = true } = {}) {
  const dir = tempDir(t, "seal");
  const script = path.join(dir, "eventloom-seal");
  writeFileSync(script, readFileSync(SOURCE, "utf8").replace(/^SEAL_DIR=.*$/m, `SEAL_DIR=${dir}`));
  chmodSync(script, 0o755);
  const file = path.join(dir, `${UID}.evtseal`);
  if (setUp) writeFileSync(file, `eventloom-seal 1 uid=${UID}\n`);
  const run = (...args) => {
    const result = spawnSync(script, args, { encoding: "utf8", env: { PATH: "/nonexistent" } });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  const records = () => readFileSync(file, "utf8").trimEnd().split("\n").slice(1).map((line) => line.split(" "));
  return { run, records, file };
}

test("records are numbered, timed by the helper, and chained from the header", (t) => {
  const { run, records, file } = helper(t);
  assert.deepEqual(run("head", "2026-10-13", "10", HASH), { status: 0, stdout: "1", stderr: "" });
  assert.equal(run("ack", "2026-10-11", "0", "purged").stdout, "2");
  assert.equal(run("head", "2026-10-13", "20", HASH).stdout, "3");

  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  let link = sha(`${lines[0]}\n`);
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split(" ");
    assert.equal(fields[0], String(index + 1));
    assert.match(fields[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(Math.abs(Date.parse(fields[1]) - Date.now()) < 60_000, "its own clock, now");
    const body = fields.slice(0, -1).join(" ");
    link = sha(`${link} ${body}\n`);
    assert.equal(fields.at(-1), `sha256:${link}`);
  }
  assert.deepEqual(records().map((fields) => fields.slice(2, 6)), [
    ["head", "2026-10-13", "10", HASH], ["ack", "2026-10-11", "0", "purged"], ["head", "2026-10-13", "20", HASH],
  ]);
});

test("a head must come after where the log last stood", (t) => {
  const { run, records } = helper(t);
  run("head", "2026-10-13", "10", HASH);
  for (const [day, position] of [["2026-10-13", "10"], ["2026-10-13", "9"], ["2026-10-12", "500"]]) {
    const result = run("head", day, position, HASH);
    assert.equal(result.status, 4, `${day} ${position}`);
    assert.match(result.stderr, /the log stood at 2026-10-13 10; .* is not after it/);
  }
  assert.equal(run("head", "2026-10-13", "11", HASH).status, 0);
  assert.equal(run("head", "2026-10-14", "1", HASH).status, 0, "a later day starts again");

  // an acknowledged recovery lets the day continue from what was kept, once
  assert.equal(run("ack", "2026-10-14", "0", "recovered").status, 0);
  assert.equal(run("head", "2026-10-14", "1", HASH).status, 0);
  assert.equal(run("head", "2026-10-14", "1", HASH).status, 4);
  // acknowledging an older day does not let today move backwards
  assert.equal(run("ack", "2026-10-01", "0", "purged").status, 0);
  assert.equal(run("head", "2026-10-14", "1", HASH).status, 4);
  assert.equal(records().length, 6, "refusals write nothing");
});

test("anything that is not exactly a request is refused and writes nothing", (t) => {
  const { run, records } = helper(t);
  const refused = [
    ["head", "2026-10-13", "10"],
    ["head", "2026-10-13", "10", HASH, "extra"],
    ["seal", "2026-10-13", "10", HASH],
    ["head", "13-10-2026", "10", HASH],
    ["head", "2026-10-13", "0", HASH],
    ["head", "2026-10-13", "-1", HASH],
    ["head", "2026-10-13", "1e3", HASH],
    ["head", "2026-10-13", "10", "sha256:abc"],
    ["head", "2026-10-13", "10", HASH.toUpperCase()],
    ["head", "2026-10-13", "10", `${HASH} extra`],
    ["head", "2026-10-13", "10", `${HASH}\n9 2026-01-01T00:00:00Z head 2026-10-13 99 ${HASH} sha256:${sha("forged")}`],
    ["head", "2026-10-13\n", "10", HASH],
    ["ack", "2026-10-13", "0", "forgotten"],
    ["ack", "2026-10-13", "0", "purged\nrecovered"],
  ];
  for (const args of refused) {
    const result = run(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /^eventloom-seal: /);
  }
  assert.deepEqual(records(), []);
});

test("without a seal file there is no sealed mode, and the helper will not start one", (t) => {
  const { run } = helper(t, { setUp: false });
  const result = run("head", "2026-10-13", "10", HASH);
  assert.equal(result.status, 3);
  assert.match(result.stderr, new RegExp(`sealed mode is not set up for uid ${UID}`));
  assert.equal(run("version").stdout, "1");
});

test("the setup script is sound shell and installs only what it says", () => {
  const setup = fileURLToPath(new URL("../seal/setup.sh", import.meta.url));
  assert.equal(spawnSync("sh", ["-n", setup]).status, 0);
  const refused = spawnSync("sh", [setup], { encoding: "utf8" });
  assert.equal(refused.status, 1, "it does nothing unless it is root");
  assert.match(refused.stderr, /run this with sudo/);
  // every path it writes is one of the four it documents
  const written = [...readFileSync(setup, "utf8").matchAll(/^(?:SEAL_DIR|HELPER)=(\S+)|^rule="([^"]+)"/gm)].map((match) => match[1] ?? match[2]);
  assert.deepEqual(written, ["/var/lib/eventloom-seal", "/usr/local/libexec/eventloom-seal", "/etc/sudoers.d/eventloom-seal-$owner"]);
});
