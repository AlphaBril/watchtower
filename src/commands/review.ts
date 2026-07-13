import type { Command } from "commander";
import { readConfig } from "../config.js";
import { makeOctokit } from "../github.js";
import { ingestPr } from "../ingest.js";
import { runPi } from "../pi.js";
import { listPolicies, readCloneComments } from "../store.js";

export function registerReview(program: Command): void {
  program
    .command("review")
    .description("Ingest one PR and run the review agent to generate clone comments")
    .argument("<pr>", "PR number", (v) => parseInt(v, 10))
    .option("--force", "re-fetch even if cached", false)
    .option("--no-agent", "ingest only; skip the review agent")
    .action(async (pr: number, opts: { force: boolean; agent: boolean }) => {
      const config = await readConfig();
      const octokit = makeOctokit();

      const res = await ingestPr(octokit, config.repo, pr, config.targetDev, {
        force: opts.force,
      });
      console.log(
        res.skipped
          ? `PR #${pr}: already cached.`
          : `PR #${pr}: ingested ${res.commentCount} review comment(s).`,
      );

      if (!opts.agent) return;

      const policies = await listPolicies();
      if (policies.length === 0) {
        console.log("No policies on disk yet — run `watchtower learn` first.");
        return;
      }

      // runPi auto-arms the .review-active marker so the isolation guard blocks
      // the review agent from reading truth/ and runs/.
      console.log(`Running review agent on PR #${pr}...`);
      await runPi("review", pr);

      // Validate the agent's output against the shared schema; fail loud on drift.
      const clone = await readCloneComments(pr);
      console.log(
        `Review agent produced ${clone.comments.length} comment(s) from ${policies.length} polic${policies.length === 1 ? "y" : "ies"}.`,
      );
    });
}
