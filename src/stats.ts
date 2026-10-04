import { writeJson } from "./fsutil.js";
import { watchtowerPaths } from "./paths.js";
import { StatsSchema, type Rule, type Stats } from "./schemas.js";
import { readValidatedOr } from "./store.js";

/**
 * Production feedback: one record per posted inline comment, with the dev's
 * latest 👍/👎. Per-rule numbers are always recomputed from these records,
 * so re-harvesting is idempotent.
 */

export const PROMOTE_MIN_RATED = 3;
export const PROMOTE_MIN_UP_RATE = 0.7;
export const RETIRE_MIN_RATED = 3;
export const RETIRE_MAX_UP_RATE = 0.5;

export function readStats(): Promise<Stats> {
  return readValidatedOr(watchtowerPaths().stats, StatsSchema, "stats/rules.json", {
    schemaVersion: 1,
    comments: {},
  });
}

export function writeStats(stats: Stats): Promise<void> {
  return writeJson(watchtowerPaths().stats, stats);
}

export interface RuleStats {
  shown: number;
  up: number;
  down: number;
}

export function ruleStats(stats: Stats): Map<string, RuleStats> {
  const out = new Map<string, RuleStats>();
  for (const c of Object.values(stats.comments)) {
    for (const id of c.ruleIds) {
      const s = out.get(id) ?? { shown: 0, up: 0, down: 0 };
      s.shown++;
      if (c.reaction === "up") s.up++;
      if (c.reaction === "down") s.down++;
      out.set(id, s);
    }
  }
  return out;
}

/**
 * Status the rule should have given its feedback; the dev approves the change
 * through the rules PR that `publish` opens.
 */
export function proposedStatus(rule: Rule, s: RuleStats | undefined): Rule["status"] {
  if (!s || rule.status === "retired") return rule.status;
  const rated = s.up + s.down;
  const upRate = rated === 0 ? 0 : s.up / rated;
  if (rated >= RETIRE_MIN_RATED && upRate < RETIRE_MAX_UP_RATE) return "retired";
  if (rule.status === "probation" && rated >= PROMOTE_MIN_RATED && upRate >= PROMOTE_MIN_UP_RATE) return "active";
  return rule.status;
}
