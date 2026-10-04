#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import { loadDotEnv } from "./env.js";
import { registerSetup } from "./commands/setup.js";
import { registerIngest } from "./commands/ingest.js";
import { registerLearn } from "./commands/learn.js";
import { registerEvaluate } from "./commands/evaluate.js";
import { registerReview } from "./commands/review.js";
import { registerHarvest } from "./commands/harvest.js";
import { registerPublish } from "./commands/publish.js";
import { registerRules } from "./commands/rules.js";
import { registerSkill } from "./commands/skill.js";

async function main(): Promise<void> {
  loadDotEnv();

  const program = new Command();
  program
    .name("watchtower")
    .description(
      "A first-reviewer clone of a developer's review concerns: learn from past reviews, pre-review PRs, improve from 👍/👎",
    )
    .version("0.2.0");

  registerSetup(program);
  registerIngest(program);
  registerLearn(program);
  registerEvaluate(program);
  registerReview(program);
  registerHarvest(program);
  registerPublish(program);
  registerRules(program);
  registerSkill(program);

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
