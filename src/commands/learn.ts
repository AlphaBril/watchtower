import type { Command } from "commander";
import { readConfig } from "../config.js";
import { findReviewedPrs, makeOctokit } from "../github.js";
import { ingestPr } from "../ingest.js";
import { runPi } from "../pi.js";
import { listPolicies, readTruth } from "../store.js";

export function registerLearn(program: Command): void {
  program
    .command("learn")
    .description(
      "Ingest the developer's reviewed PRs, then run the learn agent on each",
    )
    .option("--limit <n>", "max PRs to discover", (v) => parseInt(v, 10), 50)
    .option("--force", "re-fetch even if cached", false)
    .option("--no-agent", "ingest only; skip the learn agent")
    .action(
      async (opts: { limit: number; force: boolean; agent: boolean }) => {
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

        for (const [i, pr] of prs.entries()) {
          console.log(`\n── PR #${pr} (${i + 1}/${prs.length}) ──`);

          console.log(`  ingesting...`);
          const res = await ingestPr(octokit, config.repo, pr, config.targetDev, {
            force: opts.force,
          });
          const ingestStatus = res.skipped ? "cached" : `${res.commentCount} comment(s)`;
          console.log(`  ingested: ${ingestStatus}`);

          if (!opts.agent) {
            console.log(`  (agent skipped)`);
            continue;
          }

          // Guard: the learn agent has nothing to learn from a PR the dev left
          // no review comments on. Read the truth file for the authoritative
          // count (ingest returns 0 for cached PRs regardless of actual count).
          const truth = await readTruth(pr);
          if (truth.comments.length === 0) {
            console.log(`  no review comments by ${config.targetDev} — skipping learn agent`);
            continue;
          }

          console.log(`  running learn agent on PR #${pr} (${truth.comments.length} comment(s))...`);
          const before = await listPolicies();
          // pi inherits the terminal, so its output appears live.
          await runPi("learn", pr);
          const after = await listPolicies();
          const added = after.filter((p) => !before.includes(p));
          if (added.length > 0) {
            console.log(`  + new policies: ${added.join(", ")}`);
          }
        }

        const policies = await listPolicies();
        console.log(
          `\nDone. ${policies.length} polic${policies.length === 1 ? "y" : "ies"} on disk.`,
        );
      },
    );
}
