import type { Octokit } from "@octokit/rest";
import type { Config } from "./config.js";
import { writeJson } from "./fsutil.js";
import { devReaction, listRecentPrs, listReviewCommentsRaw, sameLogin } from "./github.js";
import { watchtowerPaths } from "./paths.js";
import { parseMarker } from "./post.js";
import { CandidatesSchema } from "./schemas.js";
import { readStats, writeStats } from "./stats.js";
import { readValidatedOr } from "./store.js";

/**
 * Collects production feedback from recent PRs:
 *  - the dev's 👍/👎 on every watchtower inline comment → stats/rules.json
 *  - PRs where the dev also left their own inline comments after a
 *    pre-review → candidates.json, so `learn` picks up what the clone missed
 */
export async function harvest(
  octokit: Octokit,
  config: Config,
  opts: { limit: number },
): Promise<{ prsScanned: number; botComments: number; rated: number; newCandidates: number[] }> {
  const stats = await readStats();
  const candidatesPath = watchtowerPaths().candidates;
  const candidates = await readValidatedOr(candidatesPath, CandidatesSchema, "candidates.json", {
    schemaVersion: 1,
    prs: [],
  });
  const known = new Set(candidates.prs);
  const newCandidates: number[] = [];
  let botComments = 0;

  const prs = await listRecentPrs(octokit, config.repo, opts.limit);
  for (const { number: pr, author } of prs) {
    if (sameLogin(author, config.targetDev)) continue;
    const comments = await listReviewCommentsRaw(octokit, config.repo, pr);
    const bot = comments.filter((c) => c.in_reply_to_id == null && parseMarker(c.body ?? "") !== null);
    if (bot.length === 0) continue;

    for (const c of bot) {
      botComments++;
      const { ruleIds } = parseMarker(c.body ?? "")!;
      stats.comments[String(c.id)] = {
        pr,
        ruleIds,
        reaction: await devReaction(octokit, config.repo, c.id, config.targetDev),
        postedAt: c.created_at,
      };
    }

    const firstBot = bot.map((c) => c.created_at).sort()[0]!;
    const devAfter = comments.some(
      (c) => sameLogin(c.user?.login, config.targetDev) && c.in_reply_to_id == null && c.created_at > firstBot,
    );
    if (devAfter && !known.has(pr)) {
      known.add(pr);
      newCandidates.push(pr);
    }
  }

  await writeStats(stats);
  await writeJson(candidatesPath, { schemaVersion: 1, prs: [...known].sort((a, b) => a - b) });
  const rated = Object.values(stats.comments).filter((c) => c.reaction !== null).length;
  return { prsScanned: prs.length, botComments, rated, newCandidates };
}
