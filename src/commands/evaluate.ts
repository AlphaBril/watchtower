import type { Command } from "commander";
import { CostLog } from "../agent.js";
import { classifyPr } from "../classify.js";
import { readConfig, skillName } from "../config.js";
import { writeJson, writeText } from "../fsutil.js";
import { isTraining } from "../ingest.js";
import { judgePr } from "../judge.js";
import { readLedger } from "../learn.js";
import { stepLogger } from "../log.js";
import { runStamp, watchtowerPaths } from "../paths.js";
import { reviewPr } from "../review.js";
import { readRules } from "../rules.js";
import { isSignal, type DevComment, type Meta } from "../schemas.js";
import { aggregate, evaluatePr, renderReportMd, type PrEval } from "../score.js";
import { listCachedMetas, readDiff, readTruth } from "../store.js";

const CONVERSATION_GRACE_MS = 10 * 60 * 1000;

/**
 * Dev comments made on the commit we replay. Later review rounds comment on
 * later commits the clone never sees, so they can't count as misses.
 */
function replayable(c: DevComment, meta: Meta): boolean {
  if (meta.diffSource === "final") return true;
  if (c.kind === "conversation") {
    return !!meta.reviewedAt && Date.parse(c.createdAt) <= Date.parse(meta.reviewedAt) + CONVERSATION_GRACE_MS;
  }
  return c.originalCommitId === meta.reviewedSha;
}

export function registerEvaluate(program: Command): void {
  program
    .command("evaluate")
    .description("Replay held-out PRs: clone reviews first, judge vs the developer, write the comfort report")
    .option("--limit <n>", "max held-out PRs to replay (most recent first)", (v) => parseInt(v, 10), 40)
    .option("--allow-leak", "run even if rules were learned from held-out PRs", false)
    .action(async (opts: { limit: number; allowLeak: boolean }) => {
      const config = await readConfig();
      if (!config.trainUntil) throw new Error("Set a split first: `watchtower setup --train-until <date>`.");
      if (!config.localRepoPath) throw new Error("Set the local clone: `watchtower setup --repo-path <path>`.");

      const paths = watchtowerPaths();
      const rules = await readRules(paths.skillDir(skillName(config)));
      if (rules.length === 0) throw new Error("No rules yet — run `watchtower learn` first.");

      const test = (await listCachedMetas())
        .filter((m) => !isTraining(m, config.trainUntil))
        .slice(-opts.limit);
      if (test.length === 0) throw new Error("No held-out PRs cached — ingest PRs reviewed after trainUntil.");

      const testPrs = new Set(test.map((m) => m.number));
      const leaked = Object.values((await readLedger()).learned).filter((l) => testPrs.has(l.pr));
      if (leaked.length > 0 && !opts.allowLeak) {
        throw new Error(
          `Rules were learned from ${new Set(leaked.map((l) => l.pr)).size} held-out PR(s) — the evaluation would be contaminated. ` +
            "Re-learn from a clean rule set, or pass --allow-leak.",
        );
      }

      const startedAt = new Date().toISOString();
      const ts = runStamp();
      const costs = new CostLog();
      const evals: PrEval[] = [];
      const log = stepLogger();

      console.log(`Replaying ${test.length} held-out PR(s) against ${rules.length} rule(s)...`);
      for (const [i, meta] of test.entries()) {
        const pr = meta.number;
        console.log(`\n  [${i + 1}/${test.length}] #${pr} ${meta.title.slice(0, 70)}`);
        try {
          const [truth, diff, classified] = await Promise.all([
            readTruth(pr),
            readDiff(pr),
            classifyPr(pr, config, { costs, log }),
          ]);
          const cls = new Map(classified.items.map((c) => [c.id, c]));
          const dev = truth.comments
            .filter((c) => replayable(c, meta) && cls.has(c.id) && isSignal(cls.get(c.id)!))
            .map((comment) => ({ comment, classification: cls.get(comment.id)! }));

          const review = await reviewPr(
            {
              pr,
              repo: config.repo,
              title: meta.title,
              description: meta.body,
              diff,
              sha: meta.reviewedSha,
              repoPath: config.localRepoPath,
              rules,
            },
            config,
            { costs, log },
          );
          await writeJson(`${paths.runDir(ts)}/reviews/${pr}.json`, review);

          const verdicts = await judgePr({ pr, title: meta.title, diff, dev, clone: review.comments }, config, { costs, log });
          const e = evaluatePr(meta, dev, review.comments, verdicts);
          evals.push(e);
          log(
            `result: concerns ${e.concerns} · caught ${e.caught} · inline ${e.clone.inline} (useful ${e.clone.inlineUseful}) · noise ${e.clone.noise}`,
          );
        } catch (err) {
          log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const agg = aggregate(evals);
      await writeJson(`${paths.runDir(ts)}/report.json`, { schemaVersion: 2, startedAt, trainUntil: config.trainUntil, aggregate: agg, prs: evals });
      await writeText(
        `${paths.runDir(ts)}/report.md`,
        renderReportMd({
          dev: config.targetDev,
          repo: config.repo,
          trainUntil: config.trainUntil.slice(0, 10),
          startedAt,
          costUsd: costs.totalUsd,
          agg,
          evals,
        }),
      );
      await costs.write(`${paths.runDir(ts)}/costs.json`);

      const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
      console.log(`\n═══ EVALUATION (${agg.prs} held-out PRs, ${agg.cleanPrs} clean) ═══`);
      console.log(`Caught first:          ${pct(agg.caughtFirstRate)} of ${agg.concerns} concerns (achievable: ${pct(agg.achievableCaughtFirstRate)})`);
      console.log(`Inline useful:         ${pct(agg.inlineUsefulRate)} of ${agg.inlineComments} inline comments`);
      console.log(`Noise per PR:          ${agg.noisePerPr} (inline on clean PRs: ${agg.inlineNoisePerCleanPr ?? "n/a"})`);
      console.log(`Missed (ctx/learn/1x): ${agg.missed.needs_context}/${agg.missed.learnable}/${agg.missed.new_concern}`);
      console.log(`Spend ≈ $${costs.totalUsd}`);
      console.log(`Report: ${paths.runDir(ts)}/report.md`);
    });
}
