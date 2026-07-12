import { Octokit } from "@octokit/rest";
import { githubToken } from "./config.js";
import type { Meta, ReviewComment } from "./schemas.js";

export function parseRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo '${repo}', expected owner/repo`);
  return { owner, repo: name };
}

export function makeOctokit(): Octokit {
  return new Octokit({ auth: githubToken() });
}

/**
 * Returns PR numbers in `repo` that `dev` submitted a review on, newest first.
 * Uses the search API `reviewed-by` qualifier.
 */
export async function findReviewedPrs(
  octokit: Octokit,
  repo: string,
  dev: string,
  limit = 50,
): Promise<number[]> {
  const q = `repo:${repo} type:pr reviewed-by:${dev}`;
  const numbers: number[] = [];
  const iterator = octokit.paginate.iterator(octokit.rest.search.issuesAndPullRequests, {
    q,
    sort: "updated",
    order: "desc",
    per_page: 100,
  });
  for await (const { data } of iterator) {
    for (const item of data) {
      numbers.push(item.number);
      if (numbers.length >= limit) return numbers;
    }
  }
  return numbers;
}

export async function fetchMeta(
  octokit: Octokit,
  repo: string,
  pr: number,
): Promise<Meta> {
  const { owner, repo: name } = parseRepo(repo);
  const { data: pull } = await octokit.rest.pulls.get({
    owner,
    repo: name,
    pull_number: pr,
  });

  const files: Meta["files"] = [];
  const fileIterator = octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner,
    repo: name,
    pull_number: pr,
    per_page: 100,
  });
  for await (const { data } of fileIterator) {
    for (const f of data) {
      files.push({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      });
    }
  }

  return {
    schemaVersion: 1,
    number: pull.number,
    repo,
    title: pull.title,
    author: pull.user?.login ?? "",
    state: pull.state,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    createdAt: pull.created_at,
    mergedAt: pull.merged_at,
    files,
  };
}

/** Fetches the full unified diff for a PR (GitHub `.diff` media type). */
export async function fetchDiff(
  octokit: Octokit,
  repo: string,
  pr: number,
): Promise<string> {
  const { owner, repo: name } = parseRepo(repo);
  const res = await octokit.rest.pulls.get({
    owner,
    repo: name,
    pull_number: pr,
    mediaType: { format: "diff" },
  });
  // With the diff media type the body is the raw patch string.
  return res.data as unknown as string;
}

/**
 * Fetches inline review comments authored by `dev` on a PR, with file/line/hunk
 * anchoring. Excludes comments by other reviewers.
 */
export async function fetchReviewComments(
  octokit: Octokit,
  repo: string,
  pr: number,
  dev: string,
): Promise<ReviewComment[]> {
  const { owner, repo: name } = parseRepo(repo);
  const comments: ReviewComment[] = [];
  const iterator = octokit.paginate.iterator(octokit.rest.pulls.listReviewComments, {
    owner,
    repo: name,
    pull_number: pr,
    per_page: 100,
  });
  for await (const { data } of iterator) {
    for (const c of data) {
      if (c.user?.login !== dev) continue;
      const side = c.side === "LEFT" ? "LEFT" : "RIGHT";
      comments.push({
        id: `gh:${c.id}`,
        path: c.path,
        line: c.line ?? null,
        startLine: c.start_line ?? null,
        side,
        diffHunk: c.diff_hunk ?? "",
        body: c.body ?? "",
        inReplyToId: c.in_reply_to_id != null ? `gh:${c.in_reply_to_id}` : null,
        createdAt: c.created_at,
        url: c.html_url,
      });
    }
  }
  return comments;
}
