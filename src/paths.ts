import { resolve } from "node:path";

/**
 * Resolves every path inside the `.watchtower/` working tree from a repo root.
 * This is the single source of truth for the on-disk layout that watchtower and
 * the pi agents share (see PLAN.md "Filesystem contract").
 */
export function watchtowerPaths(repoRoot: string = process.cwd()) {
  const root = resolve(repoRoot, ".watchtower");
  return {
    root,
    config: resolve(root, "config.json"),
    reviewMarker: resolve(root, ".review-active"),

    cachePr: (pr: number) => resolve(root, "cache", "prs", String(pr)),
    meta: (pr: number) => resolve(root, "cache", "prs", String(pr), "meta.json"),
    diff: (pr: number) => resolve(root, "cache", "prs", String(pr), "diff.patch"),

    truthDir: (pr: number) => resolve(root, "truth", String(pr)),
    reviewComments: (pr: number) =>
      resolve(root, "truth", String(pr), "review_comments.json"),

    policiesDir: resolve(root, "policies"),

    reviewsDir: (pr: number) => resolve(root, "reviews", String(pr)),
    cloneComments: (pr: number) =>
      resolve(root, "reviews", String(pr), "clone_comments.json"),

    judgePending: (pr: number) =>
      resolve(root, "judge", "pending", String(pr), "pairs.json"),
    judgeResults: (pr: number) =>
      resolve(root, "judge", "results", String(pr), "judgments.json"),

    runsDir: resolve(root, "runs"),
    runReport: (timestamp: string) =>
      resolve(root, "runs", timestamp, "report.json"),
  };
}

export type WatchtowerPaths = ReturnType<typeof watchtowerPaths>;
