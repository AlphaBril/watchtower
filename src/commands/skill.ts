import type { Command } from "commander";
import { readConfig, skillName } from "../config.js";
import { watchtowerPaths } from "../paths.js";
import {
  installPersonalSkill,
  isInstalled,
  personalSkillDir,
  uninstallPersonalSkill,
} from "../personal.js";

export function registerSkill(program: Command): void {
  const skill = program
    .command("skill")
    .description("Manage the developer's personal Claude Code skill (~/.claude/skills/<name>)");

  skill
    .command("install")
    .description("Copy the learned rules into your personal skills; kept in sync by learn/publish")
    .action(async () => {
      const config = await readConfig();
      const name = skillName(config);
      const dest = await installPersonalSkill(watchtowerPaths().skillDir(name), name);
      console.log(`Installed /${name} at ${dest}`);
    });

  skill
    .command("uninstall")
    .description("Remove the personal skill")
    .action(async () => {
      const config = await readConfig();
      console.log(`Removed ${await uninstallPersonalSkill(skillName(config))}`);
    });

  skill
    .command("status")
    .description("Show whether the personal skill is installed")
    .action(async () => {
      const config = await readConfig();
      const name = skillName(config);
      console.log(
        (await isInstalled(name))
          ? `/${name} installed at ${personalSkillDir(name)}`
          : `/${name} not installed — run \`watchtower skill install\``,
      );
    });
}
