import type { Octokit } from "@octokit/rest";
import { watchtowerPaths } from "./paths.js";
import { writeJson, writeText } from "./fsutil.js";
import {
  fetchCompareDiff,
  fetchDevComments,
  fetchDevReviews,
  fetchFiles,
  fetchPrDiff,
  fetchPull,
} from "./github.js";
import {
  MetaSchema,
  ReviewCommentsFileSchema,
  type Meta,
  type ReviewCommentsFile,
} from "./schemas.js";
import { readMeta, readTruth } from "./store.js";

export interface IngestResult {
  pr: number;
  meta: Meta;
  commentCount: number;
  skipped: boolean;
}

/**
 * Fetches a PR and the target dev's review activity, and writes:
 *   cache/prs/<pr#>/meta.json   — incl. reviewedSha / reviewedAt / review states
 *   cache/prs/<pr#>/diff.patch  — diff base…reviewedSha: the code the dev saw
 *   truth/<pr#>/review_comments.json — inline + review-body + conversation comments
 *
 * Replaying the diff at the *reviewed* commit matters: the final PR diff often
 * already contains the fix the dev asked for, so the clone couldn't raise it.
 *
 * Idempotent: skips when a v2 cache exists, unless `force`.
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
    try {
      const [meta, truth] = await Promise.all([readMeta(pr, opts.repoRoot), readTruth(pr, opts.repoRoot)]);
      return { pr, meta, commentCount: truth.comments.length, skipped: true };
    } catch {
      // Missing or v1 cache — (re-)fetch below.
    }
  }

  const [pull, files, reviews] = await Promise.all([
    fetchPull(octokit, repo, pr),
    fetchFiles(octokit, repo, pr),
    fetchDevReviews(octokit, repo, pr, dev),
  ]);
  const comments = await fetchDevComments(octokit, repo, pr, dev, reviews);

  const firstReview = reviews.find((r) => r.commitId);
  const firstInline = comments.find((c) => c.kind === "inline" && c.originalCommitId);
  const reviewedSha = firstReview?.commitId ?? firstInline?.originalCommitId ?? pull.head.sha;
  const reviewedAt = reviews[0]?.submittedAt ?? comments[0]?.createdAt ?? null;

  let diff: string;
  let diffSource: Meta["diffSource"] = "reviewed";
  try {
    diff = await fetchCompareDiff(octokit, repo, pull.base.sha, reviewedSha);
  } catch {
    // Reviewed commit no longer reachable (force-push) — best effort.
    diff = await fetchPrDiff(octokit, repo, pr);
    diffSource = "final";
  }

  const meta: Meta = {
    schemaVersion: 2,
    number: pull.number,
    repo,
    title: pull.title,
    body: pull.body ?? "",
    author: pull.user?.login ?? "",
    state: pull.state,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    createdAt: pull.created_at,
    mergedAt: pull.merged_at,
    reviewedSha,
    reviewedAt,
    devReviewStates: reviews.map((r) => r.state),
    diffSource,
    files,
  };

  const truth: ReviewCommentsFile = {
    schemaVersion: 2,
    pr,
    repo,
    reviewer: dev,
    comments,
  };

  // Validate against the shared contract before writing so drift fails here.
  await writeJson(paths.meta(pr), MetaSchema.parse(meta));
  await writeText(paths.diff(pr), diff);
  await writeJson(paths.reviewComments(pr), ReviewCommentsFileSchema.parse(truth));

  return { pr, meta, commentCount: comments.length, skipped: false };
}

/** Train/test split on the dev's first-review date. */
export function isTraining(meta: Meta, trainUntil: string | undefined): boolean {
  if (!trainUntil) return true;
  return (meta.reviewedAt ?? meta.createdAt) < trainUntil;
}
