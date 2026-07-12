import type { Command } from "commander";
import { readdir } from "node:fs/promises";
import { watchtowerPaths } from "../paths.js";

export function registerPolicies(program: Command): void {
  program
    .command("policies")
    .description("List the current policy set")
    .action(async () => {
      const { policiesDir } = watchtowerPaths();
      let files: string[];
      try {
        files = (await readdir(policiesDir)).filter((f) => f.endsWith(".md"));
      } catch {
        console.log(`No policies yet (${policiesDir} does not exist).`);
        return;
      }
      if (files.length === 0) {
        console.log("No policies yet.");
        return;
      }
      console.log(`${files.length} polic${files.length === 1 ? "y" : "ies"}:`);
      for (const f of files.sort()) console.log(`  ${f}`);
    });
}
