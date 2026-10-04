import type { Command } from "commander";
import { readConfig } from "../config.js";
import { findReviewedPrs, makeOctokit } from "../github.js";
import { ingestPr, isTraining } from "../ingest.js";

export function registerIngest(program: Command): void {
  program
    .command("ingest")
    .description("Fetch PRs the developer reviewed (incl. clean approvals) at the reviewed commit")
    .argument("[prs...]", "specific PR numbers; omit to discover")
    .option("--limit <n>", "max PRs to discover", (v) => parseInt(v, 10), 60)
    .option("--force", "re-fetch even if cached", false)
    .action(async (prArgs: string[], opts: { limit: number; force: boolean }) => {
      const config = await readConfig();
      const octokit = makeOctokit();

      let prs = prArgs.map((p) => parseInt(p, 10));
      if (prs.length === 0) {
        console.log(`Discovering PRs reviewed by ${config.targetDev} in ${config.repo}...`);
        prs = await findReviewedPrs(octokit, config.repo, config.targetDev, opts.limit);
        console.log(`Found ${prs.length} reviewed PR(s).`);
      }

      let train = 0;
      let test = 0;
      for (const pr of prs) {
        const { meta, commentCount, skipped } = await ingestPr(octokit, config.repo, pr, config.targetDev, {
          force: opts.force,
        });
        const split = isTraining(meta, config.trainUntil) ? "train" : "test";
        if (split === "train") train++;
        else test++;
        console.log(
          `  #${pr} ${skipped ? "(cached)" : ""} reviewed ${meta.reviewedAt?.slice(0, 10) ?? "?"} · ` +
            `${commentCount} comment(s) · ${meta.devReviewStates.join("/") || "no review"} · ` +
            `${meta.diffSource === "final" ? "FINAL diff (reviewed commit gone) · " : ""}${split}`,
        );
      }
      console.log(
        `\n${prs.length} PR(s): ${train} train, ${test} test` +
          (config.trainUntil ? ` (split at ${config.trainUntil.slice(0, 10)})` : " (no --train-until set: all train)"),
      );
    });
}
