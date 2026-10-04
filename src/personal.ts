import { access, cp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The developer's personal copy of the rules skill, in their own Claude Code
 * config (`~/.claude/skills/<name>/`). Personal skills only exist on that
 * developer's machine, so teammates' sessions never see the rules.
 *
 * Once installed, `learn` and `publish` re-sync it so it tracks the rules.
 */

export function personalSkillDir(name: string): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return resolve(base, "skills", name);
}

export async function isInstalled(name: string): Promise<boolean> {
  try {
    await access(join(personalSkillDir(name), "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

/** Replaces the personal skill with a fresh copy of `skillDir`. */
export async function installPersonalSkill(skillDir: string, name: string): Promise<string> {
  await access(join(skillDir, "SKILL.md")).catch(() => {
    throw new Error(`No skill at ${skillDir} yet — run \`watchtower learn\` first.`);
  });
  const dest = personalSkillDir(name);
  await rm(dest, { recursive: true, force: true });
  await cp(skillDir, dest, { recursive: true });
  return dest;
}

export async function uninstallPersonalSkill(name: string): Promise<string> {
  const dest = personalSkillDir(name);
  await rm(dest, { recursive: true, force: true });
  return dest;
}

/** Re-copies the skill only if the developer installed it. */
export async function syncPersonalSkill(skillDir: string, name: string): Promise<boolean> {
  if (!(await isInstalled(name))) return false;
  await installPersonalSkill(skillDir, name);
  return true;
}
