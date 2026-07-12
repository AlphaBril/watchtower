import type { Command } from "commander";
import { readConfig } from "../config.js";
import { makeOctokit } from "../github.js";
import { ingestPr } from "../ingest.js";

export function registerReview(program: Command): void {
  program
    .command("review")
    .description("Ingest one PR (Phase 1); policy review comes in Phase 2")
    .argument("<pr>", "PR number", (v) => parseInt(v, 10))
    .option("--force", "re-fetch even if cached", false)
    .action(async (pr: number, opts: { force: boolean }) => {
      const config = await readConfig();
      const octokit = makeOctokit();

      const res = await ingestPr(octokit, config.repo, pr, config.targetDev, {
        force: opts.force,
      });
      console.log(
        res.skipped
          ? `PR #${pr}: already cached.`
          : `PR #${pr}: ingested ${res.commentCount} review comment(s) by ${config.targetDev}.`,
      );
      console.log("Policy review (Phase 2) not yet implemented.");
    });
}
