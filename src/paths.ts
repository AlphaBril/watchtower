import { resolve } from "node:path";

/**
 * Resolves every path inside the `.watchtower/` working tree from a repo root.
 * Single source of truth for the on-disk layout (see PLAN.md "Filesystem").
 */
export function watchtowerPaths(repoRoot: string = process.cwd()) {
  const root = resolve(repoRoot, ".watchtower");
  return {
    root,
    config: resolve(root, "config.json"),
    ledger: resolve(root, "ledger.json"),
    stats: resolve(root, "stats", "rules.json"),
    candidates: resolve(root, "candidates.json"),

    meta: (pr: number) => resolve(root, "cache", "prs", String(pr), "meta.json"),
    diff: (pr: number) => resolve(root, "cache", "prs", String(pr), "diff.patch"),

    // Dev comments: never handed to the review agent (it runs in a sandbox
    // worktree outside this tree).
    reviewComments: (pr: number) =>
      resolve(root, "truth", String(pr), "review_comments.json"),
    classified: (pr: number) => resolve(root, "truth", String(pr), "classified.json"),

    review: (pr: number) => resolve(root, "reviews", String(pr), "review.json"),

    /** Local working copy of the rules skill (published into the target repo). */
    skillDir: (name: string) => resolve(root, "skill", name),

    runDir: (ts: string) => resolve(root, "runs", ts),

    /** Cached repo-audit result per rule (keyed by rule content + commit). */
    audit: (ruleId: string) => resolve(root, "audit", `${ruleId}.json`),

    /** Cached tooling-feasibility result per rule (same key as its audit). */
    tooling: (ruleId: string) => resolve(root, "audit", "tooling", `${ruleId}.json`),
  };
}

export type WatchtowerPaths = ReturnType<typeof watchtowerPaths>;

/** Filesystem-safe timestamp for run directories. */
export function runStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
