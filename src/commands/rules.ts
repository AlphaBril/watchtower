import type { Command } from "commander";
import { readConfig, skillName } from "../config.js";
import { watchtowerPaths } from "../paths.js";
import { readRules } from "../rules.js";
import { proposedStatus, readStats, ruleStats } from "../stats.js";

export function registerRules(program: Command): void {
  program
    .command("rules")
    .description("List learned rules with their production feedback")
    .action(async () => {
      const config = await readConfig();
      const rules = await readRules(watchtowerPaths().skillDir(skillName(config)));
      if (rules.length === 0) {
        console.log("No rules yet — run `watchtower learn`.");
        return;
      }
      const stats = ruleStats(await readStats());
      console.log(`${rules.length} rule(s):`);
      for (const r of rules) {
        const s = stats.get(r.id);
        const proposed = proposedStatus(r, s);
        console.log(
          `  ${r.status.padEnd(9)} ${r.severity.padEnd(7)} ${r.id}` +
            `  shown ${s?.shown ?? 0} 👍${s?.up ?? 0} 👎${s?.down ?? 0}` +
            (proposed !== r.status ? `  → ${proposed} on publish` : "") +
            `\n            ${r.title} [${r.paths.join(", ") || "all files"}]`,
        );
      }
    });
}
