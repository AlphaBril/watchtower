import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../src/env.js";

test(".env overrides the shell, skips empty values, tolerates a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-test-"));
  assert.deepEqual(loadDotEnv(dir), []);

  process.env.WT_TEST_TOKEN = "stale-from-direnv";
  process.env.WT_TEST_KEEP = "from-shell";
  writeFileSync(join(dir, ".env"), "# comment\nWT_TEST_TOKEN=fresh\nWT_TEST_KEEP=\nWT_TEST_QUOTED=\"a b\"\n");
  assert.deepEqual(loadDotEnv(dir).sort(), ["WT_TEST_QUOTED", "WT_TEST_TOKEN"]);
  assert.equal(process.env.WT_TEST_TOKEN, "fresh");
  assert.equal(process.env.WT_TEST_KEEP, "from-shell");
  assert.equal(process.env.WT_TEST_QUOTED, "a b");
});
