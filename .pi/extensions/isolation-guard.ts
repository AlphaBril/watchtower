import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, relative } from "node:path";

/**
 * Watchtower Isolation Guard
 *
 * Enforces structural isolation for the review agent:
 * - Blocks read/grep/find access to .watchtower/truth/ when in review mode
 * - Review mode is detected by the presence of a .watchtower/.review-active marker
 *   (set by the watchtower CLI before invoking `pi review`)
 *
 * This is a safety net — the review agent's system prompt already forbids it,
 * but this extension makes it a hard technical guarantee.
 */
export default function (pi: ExtensionAPI) {
  const GUARDED_TOOLS = ["read", "grep", "find", "ls"];
  const FORBIDDEN_PATHS_IN_REVIEW = [".watchtower/truth", ".watchtower/runs"];

  pi.on("tool_call", async (event, ctx) => {
    // Only guard relevant tools
    if (!GUARDED_TOOLS.includes(event.toolName)) return undefined;

    // Check if we're in review mode (marker file set by watchtower CLI)
    const markerPath = resolve(ctx.cwd, ".watchtower/.review-active");
    let inReviewMode = false;
    try {
      const { access } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      await access(markerPath, constants.F_OK);
      inReviewMode = true;
    } catch {
      // Marker doesn't exist — not in review mode, allow everything
      return undefined;
    }

    if (!inReviewMode) return undefined;

    // Extract the path from the tool call input
    const inputPath =
      (event.input as Record<string, unknown>).path as string | undefined ??
      (event.input as Record<string, unknown>).pattern as string | undefined;

    if (!inputPath) return undefined;

    const absolutePath = resolve(ctx.cwd, inputPath);
    const rel = relative(ctx.cwd, absolutePath);

    // Block access to forbidden directories
    for (const forbidden of FORBIDDEN_PATHS_IN_REVIEW) {
      if (rel === forbidden || rel.startsWith(forbidden + "/")) {
        return {
          block: true,
          reason: `ISOLATION VIOLATION: Access to "${forbidden}" is blocked during review mode. The review agent must only use cache/prs/ and policies/.`,
        };
      }
    }

    return undefined;
  });
}
