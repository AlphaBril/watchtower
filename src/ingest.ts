import type { Octokit } from "@octokit/rest";
import { access } from "node:fs/promises";
import { watchtowerPaths } from "./paths.js";
import { writeJson, writeText } from "./fsutil.js";
import {
  fetchDiff,
  fetchMeta,
  fetchReviewComments,
} from "./github.js";
import {
  MetaSchema,
  ReviewCommentsFileSchema,
  type ReviewCommentsFile,
} from "./schemas.js";

export interface IngestResult {
  pr: number;
  commentCount: number;
  skipped: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches a PR's meta, diff, and the target dev's review comments, and writes:
 *   cache/prs/<pr#>/meta.json
 *   cache/prs/<pr#>/diff.patch
 *   truth/<pr#>/review_comments.json
 *
 * Idempotent: if `force` is false and all three files exist, it skips fetching.
 */
export async function ingestPr(
  octokit: Octokit,
  repo: string,
  pr: number,
  dev: string,
  opts: { force?: boolean; repoRoot?: string } = {},
): Promise<IngestResult> {
  const paths = watchtowerPaths(opts.repoRoot);

  if (!opts.force) {
    const cached = await Promise.all([
      exists(paths.meta(pr)),
      exists(paths.diff(pr)),
      exists(paths.reviewComments(pr)),
    ]);
    if (cached.every(Boolean)) {
      return { pr, commentCount: 0, skipped: true };
    }
  }

  const [meta, diff, comments] = await Promise.all([
    fetchMeta(octokit, repo, pr),
    fetchDiff(octokit, repo, pr),
    fetchReviewComments(octokit, repo, pr, dev),
  ]);

  const reviewFile: ReviewCommentsFile = {
    schemaVersion: 1,
    pr,
    repo,
    reviewer: dev,
    comments,
  };

  // Validate against the shared contract before writing, so schema drift fails
  // here rather than surfacing later inside a pi agent.
  await writeJson(paths.meta(pr), MetaSchema.parse(meta));
  await writeText(paths.diff(pr), diff);
  await writeJson(
    paths.reviewComments(pr),
    ReviewCommentsFileSchema.parse(reviewFile),
  );

  return { pr, commentCount: comments.length, skipped: false };
}
