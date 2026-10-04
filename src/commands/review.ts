import type { Command } from "commander";
import { resolve } from "node:path";
import { CostLog } from "../agent.js";
import { readConfig, repoRulesPath, skillName } from "../config.js";
import { writeJson } from "../fsutil.js";
import { fetchPrDiff, fetchPull, makeOctokit, postReview, sameLogin } from "../github.js";
import { stepLogger } from "../log.js";
import { runStamp, watchtowerPaths } from "../paths.js";
import { renderInline, renderReviewBody } from "../post.js";
import { readRulesFromGit, reviewPr } from "../review.js";
import { readRules } from "../rules.js";

export function registerReview(program: Command): void {
  program
    .command("review")
    .description("Pre-review a PR at its head commit; print it, or post it as a non-blocking review")
    .argument("<pr>", "PR number", (v) => parseInt(v, 10))
    .option("--post", "post the review on GitHub (default: dry run)", false)
    .option("--repo-path <path>", "checkout of the target repo (default: config localRepoPath)")
    .option("--in-place", "use --repo-path directly when it is already at the PR head (CI)", false)
    .option("--skill-dir <path>", "rules skill directory (default: the local .watchtower skill)")
    .option("--rules-ref <ref>", "read rules from this git ref of the repo instead (e.g. origin/main)")
    .option("--include-own", "also review PRs authored by the target developer", false)
    .action(
      async (
        pr: number,
        opts: { post: boolean; repoPath?: string; inPlace: boolean; skillDir?: string; rulesRef?: string; includeOwn: boolean },
      ) => {
        const config = await readConfig();
        const octokit = makeOctokit();
        const repoPath = opts.repoPath ? resolve(opts.repoPath) : config.localRepoPath;
        if (!repoPath) throw new Error("No repo checkout: pass --repo-path or `watchtower setup --repo-path`.");

        const pull = await fetchPull(octokit, config.repo, pr);
        if (!opts.includeOwn && sameLogin(pull.user?.login, config.targetDev)) {
          console.log(`PR #${pr} is authored by ${config.targetDev} — skipping (use --include-own).`);
          return;
        }

        const name = skillName(config);
        const rules = opts.rulesRef
          ? await readRulesFromGit(repoPath, opts.rulesRef, repoRulesPath(config))
          : await readRules(opts.skillDir ? resolve(opts.skillDir) : watchtowerPaths().skillDir(name));
        if (rules.length === 0) {
          console.log("No rules found — nothing to pre-review with.");
          return;
        }

        const costs = new CostLog();
        const diff = await fetchPrDiff(octokit, config.repo, pr);
        const review = await reviewPr(
          {
            pr,
            repo: config.repo,
            title: pull.title,
            description: pull.body ?? "",
            diff,
            sha: pull.head.sha,
            repoPath,
            rules,
            inPlace: opts.inPlace,
          },
          config,
          { costs, log: stepLogger("  ") },
        );
        await writeJson(watchtowerPaths().review(pr), review);

        const runId = runStamp();
        const body = renderReviewBody(review, config.targetDev, runId);
        const inline = renderInline(review, runId);

        if (!opts.post) {
          console.log(body);
          for (const c of inline) console.log(`\n--- ${c.path}:${c.line}\n${c.body}`);
          console.log(`\n(dry run — ${inline.length} inline comment(s); spend ≈ $${costs.totalUsd}; pass --post to publish)`);
          return;
        }
        if (inline.length === 0 && review.summary.needsHumanJudgment.length === 0 && review.comments.length === 0) {
          console.log(`Nothing to say on PR #${pr} — not posting. Spend ≈ $${costs.totalUsd}.`);
          return;
        }
        const url = await postReview(octokit, config.repo, pr, review.sha, body, inline);
        console.log(`Posted pre-review (${inline.length} inline): ${url} · spend ≈ $${costs.totalUsd}`);
      },
    );
}
