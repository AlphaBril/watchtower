import type { Command } from "commander";
import { readConfig } from "../config.js";
import { makeOctokit } from "../github.js";
import { harvest } from "../harvest.js";

export function registerHarvest(program: Command): void {
  program
    .command("harvest")
    .description("Collect the developer's 👍/👎 on pre-review comments and queue PRs to learn from")
    .option("--limit <n>", "recent PRs to scan", (v) => parseInt(v, 10), 50)
    .action(async (opts: { limit: number }) => {
      const config = await readConfig();
      const res = await harvest(makeOctokit(), config, { limit: opts.limit });
      console.log(
        `Scanned ${res.prsScanned} PR(s): ${res.botComments} pre-review comment(s), ${res.rated} rated in total.`,
      );
      if (res.newCandidates.length > 0) {
        console.log(`Queued for learning: ${res.newCandidates.map((p) => `#${p}`).join(", ")} — run \`watchtower learn\`.`);
      }
    });
}
