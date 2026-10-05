import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CostLog, loadPrompt, runAgent } from "./agent.js";
import type { Config } from "./config.js";
import { writeJson } from "./fsutil.js";
import { matchesAny } from "./glob.js";
import { watchtowerPaths } from "./paths.js";
import { validateRule } from "./rules.js";
import {
  AuditOutputSchema,
  GroupOutputSchema,
  MergeOutputSchema,
  RULE_ID_RE,
  type AuditOutput,
  type MergeOutput,
  type Rule,
} from "./schemas.js";

/**
 * Compaction turns the raw, PR-by-PR rule set into a smaller, sharper one:
 *
 *  1. merge  — one agent call over the rule index proposes groups of possible
 *              duplicates, then one call per group folds the true ones together.
 *  2. audit  — one cheap read-only agent per rule checks it against the repo
 *              at a given commit: does the pattern occur, does the code follow
 *              it, is it already enforced by tooling, could tooling enforce it,
 *              are its paths right?
 *  3. decide — deterministic: keep / rescope / retire / contested.
 *
 * Rules are retired, never deleted. Rules backed by STRONG_EVIDENCE source
 * comments are never retired automatically — they're reported as contested.
 */

export const STRONG_EVIDENCE = 5;

// ── 1. grouping candidate duplicates ─────────────────────────────────────────

const MAX_GROUP = 8;

/**
 * One agent call over the whole rule index proposes groups of rules that may
 * be the same concern. (Word overlap doesn't work here: duplicates learned
 * from different PRs rarely share wording.) The merge step decides for real.
 */
export async function groupCandidates(rules: Rule[], config: Config, costs: CostLog): Promise<string[][]> {
  const index = rules
    .map((r) => `${r.id} | ${r.title} | ${r.kind}/${r.severity} | ${r.paths.join(", ") || "all files"} | ${r.sourceComments.length}`)
    .join("\n");
  const out = await runAgent({
    agent: "group",
    model: config.models.merge,
    systemPrompt: await loadPrompt("group"),
    prompt: `Rule index (id | title | kind/severity | paths | review comments):\n\n${index}`,
    schema: GroupOutputSchema,
    maxBudgetUsd: Math.min(config.maxBudgetUsd, 2),
    costs,
  });
  return sanitizeGroups(out.groups.map((g) => g.ids), new Set(rules.map((r) => r.id)));
}

/** Known ids only, each id in one group (first wins), 2..MAX_GROUP per group. */
export function sanitizeGroups(groups: string[][], known: Set<string>): string[][] {
  const used = new Set<string>();
  const out: string[][] = [];
  for (const g of groups) {
    const ids = [...new Set(g)].filter((id) => known.has(id) && !used.has(id)).slice(0, MAX_GROUP);
    if (ids.length < 2) continue;
    ids.forEach((id) => used.add(id));
    out.push(ids);
  }
  return out;
}

// ── 2. merging ───────────────────────────────────────────────────────────────

export interface MergeApplied {
  id: string;
  from: string[];
}

/**
 * Applies one cluster's merge output. The merged rule unions all source
 * comments (and stays active if any original was); the other originals are
 * retired. Invalid merges are rejected, never fatal.
 */
export function applyMerges(
  rules: Rule[],
  cluster: string[],
  out: MergeOutput,
): { rules: Rule[]; applied: MergeApplied[]; rejected: Array<{ from: string[]; reason: string }> } {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const inCluster = new Set(cluster);
  const used = new Set<string>();
  const applied: MergeApplied[] = [];
  const rejected: Array<{ from: string[]; reason: string }> = [];

  for (const m of out.merges) {
    const from = [...new Set(m.from)].filter((id) => inCluster.has(id) && byId.get(id)?.status !== "retired");
    try {
      if (from.length < 2) throw new Error("needs at least 2 live rules from this cluster");
      if (from.some((id) => used.has(id))) throw new Error("a rule appears in two merges");
      if (!RULE_ID_RE.test(m.id)) throw new Error("id must be kebab-case");
      if (!from.includes(m.id) && byId.has(m.id)) throw new Error(`id ${m.id} already exists`);
      const originals = from.map((id) => byId.get(id)!);
      const merged = validateRule({
        id: m.id,
        title: m.title,
        kind: m.kind,
        severity: m.severity,
        paths: [...new Set(m.paths)],
        sourceComments: [...new Set(originals.flatMap((r) => r.sourceComments))],
        status: originals.some((r) => r.status === "active") ? "active" : "probation",
        body: m.body,
      });
      for (const id of from) if (id !== merged.id) byId.set(id, { ...byId.get(id)!, status: "retired" });
      byId.set(merged.id, merged);
      from.forEach((id) => used.add(id));
      applied.push({ id: merged.id, from });
    } catch (e) {
      rejected.push({ from: m.from, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { rules: [...byId.values()], applied, rejected };
}

export async function mergeCluster(
  cluster: Rule[],
  config: Config,
  costs: CostLog,
): Promise<MergeOutput> {
  return runAgent({
    agent: "merge",
    model: config.models.merge,
    systemPrompt: await loadPrompt("merge"),
    prompt:
      "Consolidate this cluster of rules.\n\n```json\n" +
      JSON.stringify(
        cluster.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          severity: r.severity,
          paths: r.paths,
          sourceComments: r.sourceComments.length,
          body: r.body,
        })),
        null,
        2,
      ) +
      "\n```",
    schema: MergeOutputSchema,
    maxBudgetUsd: Math.min(config.maxBudgetUsd, 1),
    costs,
  });
}

// ── 3. auditing ──────────────────────────────────────────────────────────────

const TOOLING_FILE_RE =
  /(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.\w+|tsconfig[\w.-]*\.json|\.prettierrc(\.\w+)?|prettier\.config\.\w+|biome\.jsonc?|\.lintstagedrc(\.\w+)?|\.husky\/[^/]+|commitlint\.config\.\w+)$|^\.github\/workflows\/[^/]+\.ya?ml$|^package\.json$/;

export const toolingFiles = (files: string[]) => files.filter((f) => TOOLING_FILE_RE.test(f)).slice(0, 60);

export interface AuditContext {
  dir: string;
  sha: string;
  /** Every tracked file at `sha`. */
  files: string[];
  tooling: string[];
  config: Config;
  costs: CostLog;
}

/** Cache key: commit + the rule's reviewable content (status changes don't invalidate). */
function auditKey(rule: Rule, sha: string): string {
  const content = JSON.stringify([rule.title, rule.kind, rule.severity, rule.paths, rule.body]);
  return `${sha}:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

export async function auditRule(rule: Rule, ctx: AuditContext): Promise<{ result: AuditOutput; cached: boolean }> {
  const cachePath = watchtowerPaths().audit(rule.id);
  const key = auditKey(rule, ctx.sha);
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as { key: string; result: unknown };
    if (cached.key === key) return { result: AuditOutputSchema.parse(cached.result), cached: true };
  } catch {
    // no cache yet
  }

  const matching = ctx.files.filter((f) => matchesAny(f, rule.paths));
  const prompt = [
    `Audit rule \`${rule.id}\` against the repository at ${ctx.sha.slice(0, 12)}.`,
    "",
    "```json",
    JSON.stringify(
      { id: rule.id, title: rule.title, kind: rule.kind, severity: rule.severity, paths: rule.paths, sourceComments: rule.sourceComments.length, body: rule.body },
      null,
      2,
    ),
    "```",
    "",
    `Tracked files matched by the rule's paths: ${matching.length} of ${ctx.files.length}` +
      (rule.paths.length === 0 ? " (rule applies to all files)" : ""),
    ...matching.slice(0, 60).map((f) => `- ${f}`),
    matching.length > 60 ? `- … ${matching.length - 60} more` : "",
    "",
    "Tooling config files present:",
    ...(ctx.tooling.length ? ctx.tooling.map((f) => `- ${f}`) : ["- (none found)"]),
  ].join("\n");

  const result = await runAgent({
    agent: "audit",
    model: ctx.config.models.audit,
    systemPrompt: await loadPrompt("audit"),
    prompt,
    schema: AuditOutputSchema,
    tools: ["Read", "Grep", "Glob"],
    sandboxRoot: ctx.dir,
    maxTurns: 20,
    maxBudgetUsd: Math.min(ctx.config.maxBudgetUsd, 1),
    costs: ctx.costs,
  });
  await writeJson(cachePath, { key, ruleId: rule.id, sha: ctx.sha, at: new Date().toISOString(), result });
  return { result, cached: false };
}

// ── 4. deciding ──────────────────────────────────────────────────────────────

export type Action = "keep" | "rescope" | "retire" | "contested";

export interface Decision {
  ruleId: string;
  action: Action;
  reason: string;
  newPaths: string[] | null;
}

/**
 * Turns an audit into an action. Suggested globs are only accepted when each
 * one matches at least one tracked file; strong-evidence rules are never
 * retired automatically.
 */
export function decide(rule: Rule, audit: AuditOutput, files: string[]): Decision {
  const strong = rule.sourceComments.length >= STRONG_EVIDENCE;
  const retireOr = (reason: string): Decision => ({
    ruleId: rule.id,
    action: strong ? "contested" : "retire",
    reason: strong ? `${reason} — but backed by ${rule.sourceComments.length} review comments; kept for you to decide` : reason,
    newPaths: null,
  });

  if (audit.alreadyEnforced) return retireOr(`already enforced by ${audit.alreadyEnforcedBy ?? "tooling"}`);
  if (audit.verdict === "drop") return retireOr(audit.reason);

  const valid = (audit.suggestedPaths ?? []).filter((g) => files.some((f) => matchesAny(f, [g])));
  const changed = valid.length > 0 && JSON.stringify([...valid].sort()) !== JSON.stringify([...rule.paths].sort());
  if (changed) return { ruleId: rule.id, action: "rescope", reason: audit.reason, newPaths: valid };
  return { ruleId: rule.id, action: "keep", reason: audit.reason, newPaths: null };
}
