import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPersonalSkill,
  isInstalled,
  personalSkillDir,
  syncPersonalSkill,
  uninstallPersonalSkill,
} from "../src/personal.js";

test("personal skill: sync is a no-op until installed, then mirrors the source", async () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claude-cfg-"));
  const src = mkdtempSync(join(tmpdir(), "skill-src-"));
  mkdirSync(join(src, "rules"));
  writeFileSync(join(src, "SKILL.md"), "v1");
  writeFileSync(join(src, "rules", "a.md"), "rule a");

  assert.equal(await syncPersonalSkill(src, "dev-review"), false);
  assert.equal(await isInstalled("dev-review"), false);

  const dest = await installPersonalSkill(src, "dev-review");
  assert.equal(dest, personalSkillDir("dev-review"));
  assert.equal(readFileSync(join(dest, "rules", "a.md"), "utf8"), "rule a");

  // A rule removed at the source disappears from the installed copy too.
  writeFileSync(join(src, "SKILL.md"), "v2");
  rmSync(join(src, "rules", "a.md"));
  writeFileSync(join(src, "rules", "b.md"), "rule b");
  assert.equal(await syncPersonalSkill(src, "dev-review"), true);
  assert.equal(readFileSync(join(dest, "SKILL.md"), "utf8"), "v2");
  assert.ok(!existsSync(join(dest, "rules", "a.md")));
  assert.ok(existsSync(join(dest, "rules", "b.md")));

  await uninstallPersonalSkill("dev-review");
  assert.ok(!existsSync(dest));
  await assert.rejects(installPersonalSkill(mkdtempSync(join(tmpdir(), "empty-")), "x"), /learn/);
});
