import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { deriveLinks, demoEvents, launchPagePath, launchUrl, main, requestedDays, weaveSpec } from "../tapestry/server.mjs";

test("links follow cause, handoff, resume and shared goals", () => {
  const stitch = (id, minutes, extra = {}) => ({
    id, ts: new Date(Date.UTC(2026, 9, 10, 12, minutes)).toISOString(), type: "agent.note.added", family: "note",
    actor: "omp", thread: "main", session: "a", ok: true, payload: {}, causedBy: [], parent: null, ...extra,
  });
  const links = deriveLinks([
    stitch("a1", 0, { correlation: "goal" }),
    stitch("a2", 1, { type: "agent.handoff", family: "handoff", payload: { to_session_id: "b" } }),
    stitch("b1", 2, { session: "b", parent: "a1", causedBy: ["a1", "gone"], correlation: "goal" }),
    stitch("a3", 3, { type: "agent.session.resumed", family: "lifecycle" }),
  ]);
  assert.deepEqual(links, [
    { from: "a2", to: "b1", kind: "handoff" },
    { from: "a1", to: "b1", kind: "cause" },
    { from: "a2", to: "a3", kind: "resume" },
  ]);
});

test("the weave carries named fields, not payloads", () => {
  const events = demoEvents();
  events[0].payload = { ...events[0].payload, model: "opus", api_key: "sk-secret", prompt: "private text" };
  const text = JSON.stringify(weaveSpec(events));
  assert.ok(!text.includes("sk-secret"));
  assert.ok(!text.includes("private text"));
  const spec = JSON.parse(text);
  assert.equal(spec.stitches[0].detail.model, "opus");
  assert.equal(spec.stitches[0].payload, undefined);
  assert.ok(spec.links.length >= 4);
});

let dir;
let server;
const port = 20000 + (process.pid % 20000);
let key;
// As the page does it: the key from the launch page, sent as a header.
const get = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
  ...options,
  headers: { authorization: `Bearer ${key}`, ...options.headers },
});
const keyIn = (launchPage) => /#key=([A-Za-z0-9_-]+)"/.exec(readFileSync(launchPage, "utf8"))[1];

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "eventloom-tapestry-"));
  dir = path.join(root, "logs");
  mkdirSync(dir);
  process.env.EVENTLOOM_LOG_DIR = dir;
  const lines = [
    { id: "anchor", type: "eventloom.shard.anchored", actorId: "eventloom", timestamp: "2026-10-10T00:00:00.000Z", payload: {} },
    { id: "num", type: "agent.note.added", actorId: "omp", timestamp: 1791590400000, payload: { session_id: "s" } },
    { id: "late", type: "agent.note.added", actorId: "omp", timestamp: "2026-10-10T09:00:00.000Z", payload: { session_id: "s", occurred_at: "2026-10-10T08:00:00.000Z", prompt: "private" } },
    { id: "typeless", actorId: "omp", timestamp: "2026-10-10T08:30:00.000Z" },
  ].map((event) => JSON.stringify(event));
  writeFileSync(path.join(dir, "2026-10-10.jsonl"), [...lines, "42", "{ not json", ""].join("\n"));
  for (const day of ["08", "09"]) {
    const event = { id: `day${day}`, type: "agent.note.added", actorId: "omp", timestamp: `2026-10-${day}T12:00:00.000Z`, payload: { session_id: "s" } };
    writeFileSync(path.join(dir, `2026-10-${day}.jsonl`), `${JSON.stringify(event)}\n`);
  }
  server = main(["--port", String(port), "--days", "3"]);
  await new Promise((resolve) => server.once("listening", resolve));
  key = keyIn(server.launchPage);
});

after(() => {
  server?.close();
  rmSync(path.dirname(dir), { recursive: true, force: true });
  delete process.env.EVENTLOOM_LOG_DIR;
});

test("damaged and foreign lines do not stop the loom", async () => {
  const res = await get("/weave.json?days=1");
  assert.equal(res.status, 200);
  const spec = await res.json();
  assert.deepEqual(spec.stitches.map((stitch) => stitch.id).sort(), ["late", "num"]);
  const late = spec.stitches.find((stitch) => stitch.id === "late");
  assert.equal(late.ts, "2026-10-10T08:00:00.000Z");
  assert.ok(!JSON.stringify(spec).includes("private"));
});

test("?days=N weaves the last N days, and without it the whole log", async () => {
  const woven = async (query) => {
    const spec = await (await get(`/weave.json${query}`)).json();
    return { ids: spec.stitches.map((stitch) => stitch.id).sort(), days: spec.filter.days };
  };
  assert.deepEqual(await woven("?days=1"), { ids: ["late", "num"], days: 1 });
  assert.deepEqual(await woven("?days=2"), { ids: ["day09", "late", "num"], days: 2 });
  assert.deepEqual(await woven("?days=30"), { ids: ["day08", "day09", "late", "num"], days: 30 });
  // the server was started with --days 3, which sets the launch address only
  assert.deepEqual(await woven(""), { ids: ["day08", "day09", "late", "num"], days: null });
  assert.deepEqual(await woven("?days="), { ids: ["day08", "day09", "late", "num"], days: null });
  assert.deepEqual(await woven("?correlation=none&days=2"), { ids: [], days: 2 });

  for (const bad of ["0", "-1", "abc", "1.5", "7days"]) {
    const res = await get(`/weave.json?days=${bad}`);
    assert.equal(res.status, 400, bad);
    assert.match(await res.text(), /days must be a positive whole number/);
  }
});

test("the launch address carries the default number of days", () => {
  assert.equal(launchUrl({ port: 4747, days: 7, correlation: null }), "http://127.0.0.1:4747/?days=7");
  assert.equal(launchUrl({ port: 4747, days: null, correlation: null }), "http://127.0.0.1:4747/");
  assert.equal(launchUrl({ port: 4747, days: 3, correlation: "goal 1" }), "http://127.0.0.1:4747/?days=3&correlation=goal+1");
  assert.equal(requestedDays(new URLSearchParams("days=%20")), null);
  assert.equal(requestedDays(new URLSearchParams("days=14")), 14);
});

test("the log is shown only to whoever holds this run's key", async () => {
  const bare = (headers) => fetch(`http://127.0.0.1:${port}/weave.json?days=1`, { headers });
  for (const headers of [{}, { authorization: "Bearer " }, { authorization: `Bearer ${key.slice(0, -1)}x` }, { authorization: key }, { authorization: `Bearer ${key}${key}` }]) {
    const res = await bare(headers);
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.match(await res.text(), /private to the user who started it/);
  }
  assert.equal((await bare({ authorization: `Bearer ${key}` })).status, 200);
  // the page and its scripts hold nothing from the log and need no key
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/weave.js`)).status, 200);
});

test("the key reaches the browser through a page only its owner can read", () => {
  assert.equal(server.launchPage, launchPagePath(port));
  assert.equal(statSync(server.launchPage).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(server.launchPage)).mode & 0o777, 0o700);
  assert.ok(key.length >= 43, "256 bits, base64url");
  const page = readFileSync(server.launchPage, "utf8");
  // the key is in the fragment, which is never sent to a server or in a Referer
  assert.match(page, new RegExp(`location\\.replace\\("http://127\\.0\\.0\\.1:${port}/\\?days=3#key=${key}"\\)`));
  assert.match(page, /name="referrer" content="no-referrer"/);
});

test("each run has its own key, and the launch page goes when the server does", async () => {
  const other = main(["--port", String(port + 1), "--demo"]);
  await new Promise((resolve) => other.once("listening", resolve));
  const otherKey = keyIn(other.launchPage);
  assert.notEqual(otherKey, key);
  const withKey = (value) => fetch(`http://127.0.0.1:${port + 1}/weave.json`, { headers: { authorization: `Bearer ${value}` } });
  assert.equal((await withKey(key)).status, 401, "another server's key opens nothing here");
  assert.equal((await withKey(otherKey)).status, 200);
  await new Promise((resolve) => other.close(resolve));
  assert.equal(existsSync(other.launchPage), false);
});

test("only this machine, only reads, only known files", async () => {
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/weave.js?v=2")).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await get("/vendor/three.module.min.js")).status, 200);
  assert.equal((await get("/favicon.ico")).status, 404);
  assert.equal((await get("/../server.mjs")).status, 404);
  assert.equal((await get("/weave.json", { method: "POST" })).status, 405);
  // fetch will not forge a Host header; a rebinding browser would send one.
  const foreign = await new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/weave.json", headers: { host: "evil.example.com" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject).end();
  });
  assert.equal(foreign, 403);
  assert.equal((await get("/weave.json")).headers.get("x-content-type-options"), "nosniff");
});

test("bad arguments are refused with a message, not a stack trace", () => {
  const error = console.error;
  const said = [];
  console.error = (message) => said.push(String(message));
  try {
    assert.equal(main(["--port", "abc"]), null);
    assert.equal(main(["--days", "0"]), null);
    assert.equal(main(["--days", "some"]), null);
    assert.equal(main(["--nonsense"]), null);
  } finally {
    console.error = error;
    process.exitCode = 0;
  }
  assert.equal(said.length, 4);
  assert.ok(said.every((message) => message.includes("usage:")));
});
