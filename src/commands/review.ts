import type { Command } from "commander";
import { readConfig } from "../config.js";

export function registerReview(program: Command): void {
  program
    .command("review")
    .description("Apply current policies to one PR via the review agent")
    .argument("<pr>", "PR number", (v) => parseInt(v, 10))
    .action(async (pr: number) => {
      const config = await readConfig();
      console.log(
        `review: not yet implemented (Phase 1-2). ` +
          `Would review PR #${pr} in ${config.repo}.`,
      );
    });
}
