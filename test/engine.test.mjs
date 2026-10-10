import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCaptureMode, localDay, redact, redactString } from "../lib/engine.mjs";

test("localDay uses local calendar fields", () => {
  assert.equal(localDay(new Date(2026, 9, 10, 23, 30, 0)), "2026-10-10");
});

test("redacts assignment-shaped and well-known token shapes", () => {
  const samples = {
    "access_token=supersecretvalue": "access_token=[REDACTED]",
    "refresh_token=supersecretvalue": "refresh_token=[REDACTED]",
    "client_secret=supersecretvalue": "client_secret=[REDACTED]",
    "id_token=supersecretvalue": "id_token=[REDACTED]",
    "authorization=Bearer supersecretvalue": "authorization=Bearer [REDACTED]",
    "password is hunter22": "password is [REDACTED]",
    "AKIAIOSFODNN7EXAMPLE": "[REDACTED_AWS]",
    "github_pat_11AAAAAAA0abcdefghijklmnopqrstuv": "[REDACTED_GH]",
    "AIzaSyA1234567890abcdefghij": "[REDACTED_GOOGLE]",
    "xoxc-1234567890-abcdef": "[REDACTED_SLACK]",
    "npm_1234567890abcdefghij": "[REDACTED_NPM]",
    "sk-ant-api03-abcdefghijklmnop": "[REDACTED_KEY]",
    "ghp_abcdefghijklmnopqrstuvwxyz": "[REDACTED_GH]",
    "https://user:supersecret@example.com/x": "https://[REDACTED]@example.com/x",
  };
  for (const [input, expected] of Object.entries(samples)) {
    assert.equal(redactString(input), expected, input);
  }
});

test("redacts secrets stored as object fields, not only raw text", () => {
  const clean = redact({
    access_token: "supersecretvalue",
    nested: { client_secret: "anothersecret" },
    note: "authorization=Bearer supersecretvalue",
  });
  assert.equal(clean.access_token, "[REDACTED]");
  assert.equal(clean.nested.client_secret, "[REDACTED]");
  assert.equal(clean.note, "authorization=Bearer [REDACTED]");
});

test("summary mode clips nested strings after redaction", () => {
  const previous = process.env.EVENTLOOM_MODE;
  process.env.EVENTLOOM_MODE = "summary";
  try {
    const clean = applyCaptureMode({
      note: "n".repeat(500),
      nested: { transcript: `access_token=${"s".repeat(240)}`, bio: "b".repeat(400) },
    });
    assert.equal(clean.note.length, 201);
    assert.equal(clean.nested.bio.length, 201);
    assert.match(clean.nested.transcript, /access_token=\[REDACTED\]/);
  } finally {
    if (previous === undefined) delete process.env.EVENTLOOM_MODE;
    else process.env.EVENTLOOM_MODE = previous;
  }
});
