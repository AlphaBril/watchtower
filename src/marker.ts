import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { watchtowerPaths } from "./paths.js";

/**
 * The `.watchtower/.review-active` marker arms the isolation guard
 * (`.pi/extensions/isolation-guard.ts`), which hard-blocks the review agent
 * from reading `truth/` and `runs/`. It MUST be present only while the review
 * agent runs, and cleaned up afterward — even on error.
 */

export async function armReviewMarker(repoRoot?: string): Promise<void> {
  const { reviewMarker } = watchtowerPaths(repoRoot);
  await mkdir(dirname(reviewMarker), { recursive: true });
  await writeFile(reviewMarker, `${new Date().toISOString()}\n`, "utf8");
}

export async function disarmReviewMarker(repoRoot?: string): Promise<void> {
  const { reviewMarker } = watchtowerPaths(repoRoot);
  await rm(reviewMarker, { force: true });
}

/** Clears a stale marker left behind by a crashed run. Call on startup. */
export async function clearStaleMarker(repoRoot?: string): Promise<void> {
  await disarmReviewMarker(repoRoot);
}

/**
 * Runs `fn` with the review marker armed, guaranteeing the marker is removed
 * afterward via try/finally regardless of success or failure.
 */
export async function withReviewMarker<T>(
  fn: () => Promise<T>,
  repoRoot?: string,
): Promise<T> {
  await armReviewMarker(repoRoot);
  try {
    return await fn();
  } finally {
    await disarmReviewMarker(repoRoot);
  }
}
