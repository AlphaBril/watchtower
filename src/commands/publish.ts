import type { Command } from "commander";
import { readConfig, repoRulesPath, skillName } from "../config.js";
import { syncPersonalSkill } from "../personal.js";
import { defaultBranch, makeOctokit, openFilesPr } from "../github.js";
import { runStamp, watchtowerPaths } from "../paths.js";
import { readRules, renderSkillMd, serializeRule, writeRule, writeSkillIndex } from "../rules.js";
import { proposedStatus, readStats, ruleStats } from "../stats.js";

export function registerPublish(program: Command): void {
  program
    .command("publish")
    .description("Apply feedback-driven promotions/retirements and open a rules PR in the target repo (rulesPath)")
    .option("--dry-run", "show the changes without opening a PR", false)
    .action(async (opts: { dryRun: boolean }) => {
      const config = await readConfig();
      const name = skillName(config);
      const skillDir = watchtowerPaths().skillDir(name);
      const stats = ruleStats(await readStats());

      const rules = await readRules(skillDir);
      if (rules.length === 0) throw new Error("No rules to publish — run `watchtower learn` first.");

      const changes: string[] = [];
      const next = rules.map((r) => {
        const s = stats.get(r.id);
        const status = proposedStatus(r, s);
        if (status !== r.status) {
          changes.push(`- \`${r.id}\`: ${r.status} → **${status}** (shown ${s?.shown ?? 0}, 👍 ${s?.up ?? 0}, 👎 ${s?.down ?? 0})`);
        }
        return { ...r, status };
      });

      const summary = [
        `Rule set for the **${name}** pre-review skill (${next.filter((r) => r.status !== "retired").length} live rules).`,
        "",
        changes.length ? "**Status changes from 👍/👎 feedback**" : "No status changes from feedback.",
        ...changes,
        "",
        "New rules start on probation: their findings are posted inline only at high confidence until they earn 👍.",
        "Review the rule texts in `rules/` — edit or delete anything that isn't how you review.",
      ].join("\n");

      if (opts.dryRun) {
        console.log(summary);
        return;
      }

      for (const r of next) await writeRule(skillDir, r);
      await writeSkillIndex(skillDir, { name, dev: config.targetDev, repo: config.repo, rules: next });
      if (await syncPersonalSkill(skillDir, name)) console.log(`Synced personal skill /${name}.`);

      // Outside `.claude/` on purpose: CI reads it, teammates' sessions don't.
      const base = repoRulesPath(config);
      const files: Record<string, string> = {
        [`${base}/SKILL.md`]: renderSkillMd({ name, dev: config.targetDev, repo: config.repo, rules: next }),
      };
      for (const r of next) files[`${base}/rules/${r.id}.md`] = serializeRule(r);

      const octokit = makeOctokit();
      const url = await openFilesPr(octokit, config.repo, {
        base: await defaultBranch(octokit, config.repo),
        branch: `watchtower/rules-${runStamp().toLowerCase()}`,
        title: `chore(review): update ${name} pre-review rules`,
        body: summary,
        files,
      });
      console.log(`Opened rules PR: ${url}`);
    });
}
