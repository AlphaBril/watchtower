import { Octokit } from "@octokit/rest";
import { githubToken } from "./config.js";
import type { DevComment } from "./schemas.js";

export function parseRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo '${repo}', expected owner/repo`);
  return { owner, repo: name };
}

export function makeOctokit(): Octokit {
  return new Octokit({ auth: githubToken() });
}

/** GitHub logins are case-insensitive; config may not match the API's casing. */
export const sameLogin = (a: string | undefined | null, b: string) =>
  !!a && a.toLowerCase() === b.toLowerCase();

/**
 * Returns PR numbers in `repo` that `dev` submitted a review on, newest first.
 * Includes PRs the dev approved without commenting (clean-PR precision tests).
 * Uses the search API `reviewed-by` qualifier (REST search is deprecated —
 * migrate to GraphQL search before relying on this long-term).
 */
export async function findReviewedPrs(
  octokit: Octokit,
  repo: string,
  dev: string,
  limit = 50,
): Promise<number[]> {
  const q = `repo:${repo} type:pr reviewed-by:${dev} -author:${dev}`;
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

export async function fetchPull(octokit: Octokit, repo: string, pr: number) {
  const { owner, repo: name } = parseRepo(repo);
  const { data } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: pr });
  return data;
}

export async function fetchFiles(octokit: Octokit, repo: string, pr: number) {
  const { owner, repo: name } = parseRepo(repo);
  const files: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  const it = octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner,
    repo: name,
    pull_number: pr,
    per_page: 100,
  });
  for await (const { data } of it) {
    for (const f of data) {
      files.push({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions });
    }
  }
  return files;
}

export interface DevReview {
  id: number;
  state: string;
  commitId: string | null;
  submittedAt: string | null;
  body: string;
  url: string;
}

/** Reviews (approve / comment / request changes) submitted by `dev`, oldest first. */
export async function fetchDevReviews(
  octokit: Octokit,
  repo: string,
  pr: number,
  dev: string,
): Promise<DevReview[]> {
  const { owner, repo: name } = parseRepo(repo);
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo: name,
    pull_number: pr,
    per_page: 100,
  });
  return reviews
    .filter((r) => sameLogin(r.user?.login, dev) && r.state !== "PENDING")
    .map((r) => ({
      id: r.id,
      state: r.state,
      commitId: r.commit_id ?? null,
      submittedAt: r.submitted_at ?? null,
      body: r.body ?? "",
      url: r.html_url,
    }))
    .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
}

/** Unified diff for a PR (its current, final state). */
export async function fetchPrDiff(octokit: Octokit, repo: string, pr: number): Promise<string> {
  const { owner, repo: name } = parseRepo(repo);
  const res = await octokit.rest.pulls.get({
    owner,
    repo: name,
    pull_number: pr,
    mediaType: { format: "diff" },
  });
  return res.data as unknown as string;
}

/** Unified diff between two commits (three-dot: from their merge base). */
export async function fetchCompareDiff(
  octokit: Octokit,
  repo: string,
  base: string,
  head: string,
): Promise<string> {
  const { owner, repo: name } = parseRepo(repo);
  const res = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo: name,
    basehead: `${base}...${head}`,
    mediaType: { format: "diff" },
  });
  return res.data as unknown as string;
}

/**
 * Every comment `dev` left on a PR: inline review comments (anchored to the
 * commit they were written on via `original_*`), non-empty review bodies, and
 * PR conversation comments.
 */
export async function fetchDevComments(
  octokit: Octokit,
  repo: string,
  pr: number,
  dev: string,
  reviews: DevReview[],
): Promise<DevComment[]> {
  const { owner, repo: name } = parseRepo(repo);
  const comments: DevComment[] = [];

  const inline = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo: name,
    pull_number: pr,
    per_page: 100,
  });
  for (const c of inline) {
    if (!sameLogin(c.user?.login, dev)) continue;
    comments.push({
      id: `gh:${c.id}`,
      kind: "inline",
      path: c.path,
      line: c.original_line ?? c.line ?? null,
      startLine: c.original_start_line ?? c.start_line ?? null,
      side: c.side === "LEFT" ? "LEFT" : "RIGHT",
      diffHunk: c.diff_hunk ?? "",
      body: c.body ?? "",
      inReplyToId: c.in_reply_to_id != null ? `gh:${c.in_reply_to_id}` : null,
      originalCommitId: c.original_commit_id ?? null,
      createdAt: c.created_at,
      url: c.html_url,
    });
  }

  for (const r of reviews) {
    if (r.body.trim() === "") continue;
    comments.push({
      id: `gh-review:${r.id}`,
      kind: "review",
      path: null,
      line: null,
      startLine: null,
      side: "RIGHT",
      diffHunk: "",
      body: r.body,
      inReplyToId: null,
      originalCommitId: r.commitId,
      createdAt: r.submittedAt ?? "",
      url: r.url,
    });
  }

  const conversation = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo: name,
    issue_number: pr,
    per_page: 100,
  });
  for (const c of conversation) {
    if (!sameLogin(c.user?.login, dev)) continue;
    comments.push({
      id: `gh-issue:${c.id}`,
      kind: "conversation",
      path: null,
      line: null,
      startLine: null,
      side: "RIGHT",
      diffHunk: "",
      body: c.body ?? "",
      inReplyToId: null,
      originalCommitId: null,
      createdAt: c.created_at,
      url: c.html_url,
    });
  }

  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── posting & feedback ───────────────────────────────────────────────────────

export interface InlineDraft {
  path: string;
  line: number;
  startLine: number | null;
  body: string;
}

/** Posts one non-blocking (COMMENT) review with inline comments. */
export async function postReview(
  octokit: Octokit,
  repo: string,
  pr: number,
  commitId: string,
  body: string,
  inline: InlineDraft[],
): Promise<string> {
  const { owner, repo: name } = parseRepo(repo);
  const { data } = await octokit.rest.pulls.createReview({
    owner,
    repo: name,
    pull_number: pr,
    commit_id: commitId,
    event: "COMMENT",
    body,
    comments: inline.map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT" as const,
      ...(c.startLine !== null && c.startLine < c.line
        ? { start_line: c.startLine, start_side: "RIGHT" as const }
        : {}),
      body: c.body,
    })),
  });
  return data.html_url;
}

export async function listRecentPrs(
  octokit: Octokit,
  repo: string,
  limit: number,
): Promise<Array<{ number: number; author: string }>> {
  const { owner, repo: name } = parseRepo(repo);
  const out: Array<{ number: number; author: string }> = [];
  const it = octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner,
    repo: name,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  for await (const { data } of it) {
    for (const p of data) {
      out.push({ number: p.number, author: p.user?.login ?? "" });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export async function listReviewCommentsRaw(octokit: Octokit, repo: string, pr: number) {
  const { owner, repo: name } = parseRepo(repo);
  return octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo: name,
    pull_number: pr,
    per_page: 100,
  });
}

/** The dev's 👍/👎 on one review comment; the latest one wins if both exist. */
export async function devReaction(
  octokit: Octokit,
  repo: string,
  commentId: number,
  dev: string,
): Promise<"up" | "down" | null> {
  const { owner, repo: name } = parseRepo(repo);
  const reactions = await octokit.paginate(octokit.rest.reactions.listForPullRequestReviewComment, {
    owner,
    repo: name,
    comment_id: commentId,
    per_page: 100,
  });
  const mine = reactions
    .filter((r) => sameLogin(r.user?.login, dev) && (r.content === "+1" || r.content === "-1"))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const last = mine.at(-1);
  return last ? (last.content === "+1" ? "up" : "down") : null;
}

/** Commits `files` onto a new branch off `base` and opens a PR. Returns its URL. */
export async function openFilesPr(
  octokit: Octokit,
  repo: string,
  opts: { base: string; branch: string; title: string; body: string; files: Record<string, string> },
): Promise<string> {
  const { owner, repo: name } = parseRepo(repo);
  const git = octokit.rest.git;
  const { data: baseRef } = await git.getRef({ owner, repo: name, ref: `heads/${opts.base}` });
  const baseSha = baseRef.object.sha;
  const { data: baseCommit } = await git.getCommit({ owner, repo: name, commit_sha: baseSha });
  const { data: tree } = await git.createTree({
    owner,
    repo: name,
    base_tree: baseCommit.tree.sha,
    tree: Object.entries(opts.files).map(([path, content]) => ({
      path,
      mode: "100644" as const,
      type: "blob" as const,
      content,
    })),
  });
  const { data: commit } = await git.createCommit({
    owner,
    repo: name,
    message: opts.title,
    tree: tree.sha,
    parents: [baseSha],
  });
  await git.createRef({ owner, repo: name, ref: `refs/heads/${opts.branch}`, sha: commit.sha });
  const { data: pull } = await octokit.rest.pulls.create({
    owner,
    repo: name,
    base: opts.base,
    head: opts.branch,
    title: opts.title,
    body: opts.body,
  });
  return pull.html_url;
}

export async function defaultBranch(octokit: Octokit, repo: string): Promise<string> {
  const { owner, repo: name } = parseRepo(repo);
  const { data } = await octokit.rest.repos.get({ owner, repo: name });
  return data.default_branch;
}
