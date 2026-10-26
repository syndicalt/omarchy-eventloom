// A recorded session may start before its repository is trusted. These use
// real Git configuration and the CLI, rather than mocking Git's callbacks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../lib/eventloom.mjs", import.meta.url));

function repository(t, { commit = true } = {}) {
  const home = tempDir(t, "provenance");
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  const env = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", EVENTLOOM_LOG_DIR: path.join(home, "logs"),
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (args, cwd = repo) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(["init", "-b", "main"]);
  writeFileSync(path.join(repo, "tracked.txt"), "original\n");
  writeFileSync(path.join(repo, ".gitattributes"), "tracked.txt filter=fixture\n");
  git(["add", "."]);
  if (commit) git(["commit", "-m", "fixture"]);
  const cli = (args, { input = "", ...overrides } = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env: { ...env, ...overrides }, input, encoding: "utf8" });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  const recorded = (cwd = repo, type = "agent.session.started", payload = {}) => {
    cli(["append", type, "--actor", "fixture", "--payload", JSON.stringify({ cwd, ...payload })]);
    return JSON.parse(cli(["tail", "--limit", "1"])).payload;
  };
  const callback = (name, body = "printf 'token\\0\\0'\n") => {
    const marker = path.join(home, `${name}.ran`);
    const script = path.join(home, `${name}.sh`);
    writeFileSync(script, `#!/bin/sh\nprintf ran >> '${marker}'\n${body}`, { mode: 0o755 });
    return { marker, script };
  };
  return { home, repo, env, git, cli, recorded, callback };
}

test("session recording never executes a repository fsmonitor command, with memory off or on", (t) => {
  const box = repository(t);
  const { script, marker } = box.callback("fsmonitor");
  box.git(["config", "core.fsmonitor", script]);
  const index = path.join(box.repo, ".git", "index");
  const before = readFileSync(index);
  for (const memory of ["0", "1"]) {
    box.cli(["claude-hook"], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: `fixture-${memory}`, cwd: box.repo }),
      EVENTLOOM_MEMORY: memory,
    });
    assert.equal(existsSync(marker), false, "the fsmonitor command must never execute");
  }
  assert.deepEqual(readFileSync(index), before, "recording must not refresh the index");
  assert.equal(existsSync(`${index}.lock`), false);
});

test("session recording never invokes clean filters while checking a modified tracked file", (t) => {
  const box = repository(t);
  const { script, marker } = box.callback("filter", "cat\n");
  box.git(["config", "filter.fixture.clean", script]);
  writeFileSync(path.join(box.repo, "tracked.txt"), "modified\n");
  utimesSync(path.join(box.repo, "tracked.txt"), 1, 1); // same size, different stat: Git must compare content
  box.recorded();
  assert.equal(existsSync(marker), false, "clean filters must never execute");
});

test("session recording does not inspect a submodule's fsmonitor configuration", (t) => {
  const box = repository(t);
  const child = path.join(box.repo, "child");
  mkdirSync(child);
  box.git(["init", "-b", "main"], child);
  box.git(["commit", "--allow-empty", "-m", "child fixture"], child);
  box.git(["add", "child"]);
  box.git(["commit", "-m", "gitlink fixture"]);
  const { script, marker } = box.callback("submodule-fsmonitor");
  box.git(["config", "core.fsmonitor", script], child);
  box.recorded();
  assert.equal(existsSync(marker), false, "nested repository callbacks must never execute");
});

test("linked worktree provenance reads refs without using its fsmonitor command", (t) => {
  const box = repository(t);
  const linked = path.join(box.home, "linked");
  box.git(["worktree", "add", "-b", "linked", linked]);
  box.git(["config", "extensions.worktreeConfig", "true"]);
  const { script, marker } = box.callback("worktree-fsmonitor");
  box.git(["config", "--worktree", "core.fsmonitor", script], linked);
  const payload = box.recorded(linked, "agent.session.resumed");
  assert.equal(existsSync(marker), false, "worktree-local callbacks must never execute");
  assert.equal(payload.git_branch, "linked");
  assert.equal(payload.git_commit, box.git(["rev-parse", "HEAD"]).slice(0, 12));
});

test("branch and commit remain available without claiming a clean or dirty worktree", (t) => {
  const box = repository(t);
  const commit = box.git(["rev-parse", "HEAD"]).slice(0, 12);
  for (const type of ["agent.session.started", "agent.session.resumed"]) {
    const payload = box.recorded(box.repo, type);
    assert.equal(payload.git_branch, "main");
    assert.equal(payload.git_commit, commit);
    assert.equal(Object.hasOwn(payload, "git_dirty"), false);
    writeFileSync(path.join(box.repo, "tracked.txt"), "modified\n");
  }
});

test("unborn and detached HEADs preserve the available reference metadata", (t) => {
  const box = repository(t, { commit: false });
  const unborn = box.recorded();
  assert.equal(unborn.git_branch, "main");
  assert.equal(Object.hasOwn(unborn, "git_commit"), false);
  assert.equal(Object.hasOwn(unborn, "git_dirty"), false);
  box.git(["commit", "-m", "fixture"]);
  const commit = box.git(["rev-parse", "HEAD"]);
  box.git(["checkout", "--detach", commit]);
  const detached = box.recorded();
  assert.equal(detached.git_branch, "(detached)");
  assert.equal(detached.git_commit, commit.slice(0, 12));
});

test("repository discovery fails softly and adapter-supplied provenance is preserved", (t) => {
  const box = repository(t);
  for (const cwd of [box.home, path.join(box.home, "gone")]) {
    const payload = box.recorded(cwd);
    assert.equal(typeof payload.host, "string");
    assert.equal(Object.hasOwn(payload, "git_branch"), false);
    assert.equal(Object.hasOwn(payload, "git_commit"), false);
    assert.equal(Object.hasOwn(payload, "git_dirty"), false);
  }
  const supplied = { git_branch: "adapter-branch", git_commit: "adapter-commit", git_dirty: true };
  const payload = box.recorded(box.repo, "agent.session.started", supplied);
  for (const [key, value] of Object.entries(supplied)) assert.equal(payload[key], value);
});
