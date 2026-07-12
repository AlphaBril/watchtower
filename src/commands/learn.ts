import type { Command } from "commander";
import { readConfig } from "../config.js";
import { findReviewedPrs, makeOctokit } from "../github.js";
import { ingestPr } from "../ingest.js";

export function registerLearn(program: Command): void {
  program
    .command("learn")
    .description(
      "Ingest the developer's reviewed PRs, then learn/review/judge/score each",
    )
    .option("--limit <n>", "max PRs to discover", (v) => parseInt(v, 10), 50)
    .option("--force", "re-fetch even if cached", false)
    .action(async (opts: { limit: number; force: boolean }) => {
      const config = await readConfig();
      const octokit = makeOctokit();

      console.log(
        `Discovering PRs reviewed by ${config.targetDev} in ${config.repo}...`,
      );
      const prs = await findReviewedPrs(
        octokit,
        config.repo,
        config.targetDev,
        opts.limit,
      );
      console.log(`Found ${prs.length} reviewed PR(s).`);

      let totalComments = 0;
      for (const pr of prs) {
        const res = await ingestPr(octokit, config.repo, pr, config.targetDev, {
          force: opts.force,
        });
        totalComments += res.commentCount;
        const status = res.skipped
          ? "cached"
          : `${res.commentCount} comment(s)`;
        console.log(`  PR #${pr}: ${status}`);
      }

      console.log(
        `\nIngested ${prs.length} PR(s), ${totalComments} new review comment(s).`,
      );
      console.log(
        "Policy learning + validation (Phase 2-3) not yet implemented.",
      );
    });
}
