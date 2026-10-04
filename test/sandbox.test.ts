import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSandbox } from "../src/sandbox.js";

function repoWithTwoCommits(): { dir: string; first: string; second: string } {
  const dir = mkdtempSync(join(tmpdir(), "wt-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "f.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "one");
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "f.txt"), "two\n");
  git("commit", "-qam", "two");
  return { dir, first, second: git("rev-parse", "HEAD") };
}

test("withSandbox checks out the requested commit and always cleans up", async () => {
  const { dir, first } = repoWithTwoCommits();
  let seen = "";
  const content = await withSandbox(dir, first, async (wt) => {
    seen = wt;
    return readFileSync(join(wt, "f.txt"), "utf8");
  });
  assert.equal(content, "one\n");
  assert.ok(!existsSync(seen));

  await assert.rejects(
    withSandbox(dir, first, async (wt) => {
      seen = wt;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(!existsSync(seen));
  const worktrees = execFileSync("git", ["-C", dir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n");
  assert.equal(worktrees.length, 1);
});

test("withSandbox inPlace reuses the checkout when HEAD matches", async () => {
  const { dir, second } = repoWithTwoCommits();
  const used = await withSandbox(dir, second, async (wt) => wt, { inPlace: true });
  assert.equal(used, dir);
});

test("withSandbox fails clearly on an unknown commit", async () => {
  const { dir } = repoWithTwoCommits();
  await assert.rejects(withSandbox(dir, "deadbeef".repeat(5), async () => 1), /not available/);
});
