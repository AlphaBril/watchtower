import type { Command } from "commander";
import { readConfig } from "../config.js";

export function registerLearn(program: Command): void {
  program
    .command("learn")
    .description(
      "Ingest the developer's reviewed PRs, then learn/review/judge/score each",
    )
    .action(async () => {
      const config = await readConfig();
      console.log(
        `learn: not yet implemented (Phase 1-3). ` +
          `Would mine ${config.targetDev}'s reviews in ${config.repo}.`,
      );
    });
}
