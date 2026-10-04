import type { Command } from "commander";
import { resolve } from "node:path";
import { ConfigSchema, githubToken, readConfig, repoRulesPath, skillName, writeConfig } from "../config.js";
import { watchtowerPaths } from "../paths.js";

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Persist target developer, repo, local clone, split date and thresholds")
    .option("--dev <login>", "target developer's GitHub login")
    .option("--repo <owner/repo>", "repository to scope reviews to")
    .option("--repo-path <path>", "local clone of the target repo (for review sandboxes)")
    .option("--train-until <date>", "ISO date: learn from PRs reviewed before it, evaluate on the rest")
    .option("--skill-name <name>", "skill directory name (default: <dev>-review)")
    .option("--rules-path <path>", "rules folder in the target repo (default: .github/review-rules/<skill-name>)")
    .option("--post-threshold <n>", "min confidence to post probation/no-rule findings inline", parseFloat)
    .option("--max-budget <usd>", "spend cap per agent call", parseFloat)
    .action(async (opts) => {
      // Fail fast if the PAT isn't available — setup is the natural place to check.
      githubToken();

      const existing = await readConfig().catch(() => null);
      if (!existing && (!opts.dev || !opts.repo)) {
        throw new Error("First setup needs --dev and --repo.");
      }
      const config = ConfigSchema.parse({
        ...existing,
        ...(opts.dev && { targetDev: opts.dev }),
        ...(opts.repo && { repo: opts.repo }),
        ...(opts.repoPath && { localRepoPath: resolve(opts.repoPath) }),
        ...(opts.trainUntil && { trainUntil: new Date(opts.trainUntil).toISOString() }),
        ...(opts.skillName && { skillName: opts.skillName }),
        ...(opts.rulesPath && { rulesPath: opts.rulesPath }),
        ...(opts.postThreshold !== undefined && { postThreshold: opts.postThreshold }),
        ...(opts.maxBudget !== undefined && { maxBudgetUsd: opts.maxBudget }),
      });

      await writeConfig(config);
      console.log(`Wrote config to ${watchtowerPaths().config}`);
      console.log(`  target dev:   ${config.targetDev}`);
      console.log(`  repo:         ${config.repo}`);
      console.log(`  local clone:  ${config.localRepoPath ?? "(not set — needed for evaluate/review)"}`);
      console.log(`  train until:  ${config.trainUntil ?? "(not set — needed for evaluate)"}`);
      console.log(`  skill:        /${skillName(config)} (personal: \`watchtower skill install\`)`);
      console.log(`  repo rules:   ${repoRulesPath(config)} (written by publish, read by CI)`);
      console.log(`  models:       ${Object.entries(config.models).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    });
}
