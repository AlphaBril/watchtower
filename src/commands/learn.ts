import type { Command } from "commander";
import { CostLog } from "../agent.js";
import { readConfig, skillName } from "../config.js";
import { writeJson } from "../fsutil.js";
import { makeOctokit } from "../github.js";
import { ingestPr, isTraining } from "../ingest.js";
import { forgetPr, learnPr } from "../learn.js";
import { stepLogger } from "../log.js";
import { runStamp, watchtowerPaths } from "../paths.js";
import { CandidatesSchema } from "../schemas.js";
import { listCachedMetas, readMeta, readTruth, readValidatedOr } from "../store.js";

export function registerLearn(program: Command): void {
  program
    .command("learn")
    .description("Classify dev comments and learn rules from training PRs (+ harvested candidates)")
    .argument("[prs...]", "specific PR numbers; omit for all cached training PRs and candidates")
    .option("--forget", "drop these PRs from the ledger first so they are re-learned", false)
    .option("--since <date>", "only training PRs first reviewed on/after this date")
    .option("--recent <n>", "only the N most recent training PRs that have dev comments", (v) => parseInt(v, 10))
    .action(async (prArgs: string[], opts: { forget: boolean; since?: string; recent?: number }) => {
      const config = await readConfig();
      const paths = watchtowerPaths();
      const costs = new CostLog();

      let prs: number[];
      if (prArgs.length > 0) {
        prs = prArgs.map((p) => parseInt(p, 10));
        for (const pr of prs) {
          const meta = await readMeta(pr);
          if (!isTraining(meta, config.trainUntil)) {
            throw new Error(`PR #${pr} is in the held-out test set (reviewed after trainUntil); learning from it would leak into evaluate.`);
          }
        }
      } else {
        const metas = await listCachedMetas();
        const candidates = await readValidatedOr(paths.candidates, CandidatesSchema, "candidates.json", { schemaVersion: 1, prs: [] });
        if (candidates.prs.length > 0) {
          // Harvested PRs: (re-)ingest so the dev's latest comments are in truth/.
          const octokit = makeOctokit();
          console.log(`Ingesting ${candidates.prs.length} harvested candidate PR(s)...`);
          for (const pr of candidates.prs) {
            await ingestPr(octokit, config.repo, pr, config.targetDev, { force: true });
          }
        }
        // Only PRs with dev comments can teach anything; approvals are skipped.
        const since = opts.since ? new Date(opts.since).toISOString() : "";
        let training: number[] = [];
        for (const m of metas) {
          if (!isTraining(m, config.trainUntil) || (m.reviewedAt ?? m.createdAt) < since) continue;
          if ((await readTruth(m.number)).comments.length > 0) training.push(m.number);
        }
        if (opts.recent !== undefined) training = training.slice(-opts.recent);
        prs = [...new Set([...training, ...candidates.prs])];
      }
      if (prs.length === 0) {
        console.log("Nothing to learn from — run `watchtower ingest` first.");
        return;
      }

      const created: string[] = [];
      const updated = new Set<string>();
      const costsPath = `${paths.runDir(runStamp())}/costs.json`;
      const log = stepLogger();
      for (const [i, pr] of prs.entries()) {
        if (opts.forget) await forgetPr(pr);
        const meta = await readMeta(pr);
        console.log(`\n  [${i + 1}/${prs.length}] #${pr} ${meta.title.slice(0, 70)} (${meta.reviewedAt?.slice(0, 10) ?? "?"})`);
        const res = await learnPr(pr, config, { costs, log });
        // Saved after every PR so an interrupted run still records its spend.
        await costs.write(costsPath);
        if (!res) {
          log("nothing new to learn");
          continue;
        }
        created.push(...res.created);
        res.updated.forEach((u) => updated.add(u));
        log(
          `${res.newComments} new comment(s) → +${res.created.length} rule(s), ~${res.updated.length} updated, ` +
            `${res.skipped.length} skipped${res.rejected.length ? `, ${res.rejected.length} rejected` : ""} · run total $${costs.totalUsd}`,
        );
        for (const s of res.skipped) log(`  skip ${s.commentId}: ${s.reason}`);
        for (const r of res.rejected) log(`  reject ${r.id}: ${r.reason}`);
      }

      // Candidates are consumed once processed (the ledger remembers them).
      await writeJson(paths.candidates, { schemaVersion: 1, prs: [] });
      console.log(
        `\nDone: ${created.length} new rule(s), ${updated.size} updated. Spend ≈ $${costs.totalUsd}. ` +
          `Rules in ${paths.skillDir(skillName(config))} — see \`watchtower rules\`.`,
      );
    });
}
