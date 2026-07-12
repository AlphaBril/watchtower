import type { Command } from "commander";
import { ConfigSchema, githubToken, writeConfig } from "../config.js";
import { watchtowerPaths } from "../paths.js";

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Persist target developer, repo, and thresholds to config")
    .requiredOption("--dev <login>", "target developer's GitHub login")
    .requiredOption("--repo <owner/repo>", "repository to scope reviews to")
    .option("--threshold <n>", "validation score threshold (0-1)", parseFloat)
    .option("--max-iterations <n>", "max refine iterations", (v) => parseInt(v, 10))
    .action(async (opts) => {
      // Fail fast if the PAT isn't available — setup is the natural place to check.
      githubToken();

      const config = ConfigSchema.parse({
        targetDev: opts.dev,
        repo: opts.repo,
        ...(opts.threshold !== undefined && { validationThreshold: opts.threshold }),
        ...(opts.maxIterations !== undefined && { maxIterations: opts.maxIterations }),
      });

      await writeConfig(config);
      const { config: configPath } = watchtowerPaths();
      console.log(`Wrote config to ${configPath}`);
      console.log(`  target dev: ${config.targetDev}`);
      console.log(`  repo:       ${config.repo}`);
      console.log(`  threshold:  ${config.validationThreshold}`);
      console.log(`  max iters:  ${config.maxIterations}`);
    });
}
