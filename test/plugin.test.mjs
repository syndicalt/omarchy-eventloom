// The repository is an Omarchy plugin: `omarchy plugin add` clones it and
// loads what manifest.json names. These tests hold the manifest to what the
// shell requires and to the rest of the repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(path.join(REPO, file), "utf8"));
const manifest = readJson("manifest.json");

test("the manifest names a service that exists, under the same version as the package", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "syndicalt.eventloom");
  assert.equal(manifest.version, readJson("package.json").version);
  assert.deepEqual(manifest.kinds, ["service"]);
  assert.ok(existsSync(path.join(REPO, manifest.entryPoints.service)));
  assert.ok(existsSync(path.join(REPO, "LICENSE")));
});

test("the service runs the scripts that exist, and they are executable", () => {
  const service = readFileSync(path.join(REPO, manifest.entryPoints.service), "utf8");
  const scripts = [...service.matchAll(/"\/(plugin\/[\w.-]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(scripts)].sort(), ["plugin/open-tapestry.sh", "plugin/setup.sh"]);
  for (const script of scripts) {
    assert.equal(spawnSync("sh", ["-n", path.join(REPO, script)]).status, 0, script);
  }
});

// A fresh clone is what Omarchy validates, so only what git would ship is
// copied: a development checkout's node_modules holds symlinks, which the
// validator refuses.
const validator = spawnSync("sh", ["-c", "command -v omarchy-plugin-validate"], { encoding: "utf8" }).stdout.trim();

test("a clone of the repository passes omarchy plugin validate", { skip: validator ? false : "Omarchy is not installed here" }, (t) => {
  const clone = tempDir(t, "plugin");
  const shipped = spawnSync("git", ["--no-optional-locks", "ls-files", "-co", "--exclude-standard"], { cwd: REPO, encoding: "utf8" })
    .stdout.split("\n").filter((file) => file && existsSync(path.join(REPO, file)));
  for (const file of shipped) {
    mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
    cpSync(path.join(REPO, file), path.join(clone, file));
  }
  const result = spawnSync(validator, [clone], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
