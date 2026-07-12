#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import { clearStaleMarker } from "./marker.js";
import { registerSetup } from "./commands/setup.js";
import { registerLearn } from "./commands/learn.js";
import { registerReview } from "./commands/review.js";
import { registerPolicies } from "./commands/policies.js";

async function main(): Promise<void> {
  // A crashed review run may leave the isolation-guard marker behind, which
  // would wrongly block later reads. Clear any stale marker on startup.
  await clearStaleMarker();

  const program = new Command();
  program
    .name("watchtower")
    .description(
      "Build a digital clone of a developer's PR-review style from their past reviews",
    )
    .version("0.0.0");

  registerSetup(program);
  registerLearn(program);
  registerReview(program);
  registerPolicies(program);

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
