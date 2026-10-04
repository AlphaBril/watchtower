import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The review agent runs inside a sandbox: a detached git worktree of the
 * target repo at the reviewed commit, in a temp dir. Nothing from
 * `.watchtower/` (dev comments, scores) exists there, so isolation holds by
 * construction; the agent's PreToolUse hook additionally denies paths that
 * escape the worktree.
 */

const git = (repo: string, args: string[]) => execa("git", ["-C", repo, ...args]);

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  try {
    await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Makes `sha` available locally: fetch the PR head ref, then the sha itself. */
export async function ensureCommit(repo: string, sha: string, pr?: number): Promise<void> {
  if (await hasCommit(repo, sha)) return;
  if (pr !== undefined) {
    await git(repo, ["fetch", "--quiet", "origin", `pull/${pr}/head`]).catch(() => undefined);
    if (await hasCommit(repo, sha)) return;
  }
  await git(repo, ["fetch", "--quiet", "origin", sha]).catch(() => undefined);
  if (!(await hasCommit(repo, sha))) {
    throw new Error(`commit ${sha.slice(0, 12)} is not available in ${repo} (force-pushed away?)`);
  }
}

/**
 * Runs `fn` with a worktree of `repo` checked out at `sha`. The worktree is
 * always removed afterward, even on error. With `inPlace`, `repo` itself is
 * used when its HEAD already is `sha` (CI: the checkout is the PR head).
 */
export async function withSandbox<T>(
  repo: string,
  sha: string,
  fn: (dir: string) => Promise<T>,
  opts: { pr?: number; inPlace?: boolean } = {},
): Promise<T> {
  if (opts.inPlace) {
    const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
    if (stdout.trim() === sha) return fn(repo);
  }
  await ensureCommit(repo, sha, opts.pr);
  const parent = await mkdtemp(join(tmpdir(), "watchtower-"));
  const dir = join(parent, "repo");
  await git(repo, ["worktree", "add", "--detach", "--quiet", dir, sha]);
  try {
    return await fn(dir);
  } finally {
    await git(repo, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]).catch(() => undefined);
  }
}
