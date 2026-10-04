import { execa } from "execa";
import { loadPrompt, runAgent, type CostLog } from "./agent.js";
import { kb, silent, type Log } from "./log.js";
import type { Config } from "./config.js";
import { changedPaths, commentableLines, filterDiff, isNoiseFile } from "./diff.js";
import { applicableRules, parseRule } from "./rules.js";
import { withSandbox } from "./sandbox.js";
import {
  ReviewOutputSchema,
  type CloneComment,
  type ReviewFile,
  type Rule,
} from "./schemas.js";

/**
 * Runs the first-reviewer agent on one PR at one commit, inside a sandbox
 * worktree, then gates its findings:
 *   inline  — anchorable on the diff AND (cites an `active` rule OR
 *             confidence ≥ postThreshold)
 *   summary — everything else worth mentioning (folded into the review body)
 *   drop    — confidence < MIN_CONFIDENCE
 */

export const MIN_CONFIDENCE = 0.5;

export type Placement = "inline" | "summary" | "drop";

export function placeFinding(
  f: { path: string; line: number; ruleIds: string[]; confidence: number },
  ctx: { lines: Map<string, Set<number>>; status: Map<string, Rule["status"]>; threshold: number },
): Placement {
  if (f.confidence < MIN_CONFIDENCE) return "drop";
  const anchorable = ctx.lines.get(f.path)?.has(f.line) ?? false;
  if (!anchorable) return "summary";
  const citesActive = f.ruleIds.some((id) => ctx.status.get(id) === "active");
  return citesActive || f.confidence >= ctx.threshold ? "inline" : "summary";
}

export interface ReviewInput {
  pr: number;
  repo: string;
  title: string;
  description: string;
  diff: string;
  sha: string;
  repoPath: string;
  rules: Rule[];
  /** CI: use repoPath directly when its HEAD is `sha`. */
  inPlace?: boolean;
}

export async function reviewPr(
  input: ReviewInput,
  config: Config,
  opts: { costs?: CostLog; log?: Log } = {},
): Promise<ReviewFile> {
  const log = opts.log ?? silent;
  const changed = changedPaths(input.diff).filter((p) => !isNoiseFile(p));
  const applicable = applicableRules(input.rules, changed);
  log(`review: ${changed.length} changed file(s) · ${applicable.length} of ${input.rules.length} rule(s) apply`);
  const base = {
    schemaVersion: 2 as const,
    pr: input.pr,
    repo: input.repo,
    sha: input.sha,
    generatedAt: new Date().toISOString(),
    rulesApplied: applicable.map((r) => r.id),
  };

  if (applicable.length === 0) {
    return {
      ...base,
      comments: [],
      summary: {
        risk: "medium",
        overview: "No learned review concerns cover the files changed in this PR.",
        needsHumanJudgment: [{ area: "Whole PR", why: "Outside the areas the pre-review has learned; review it fully." }],
      },
    };
  }

  const { text: diffText, dropped } = filterDiff(input.diff);
  const prompt = [
    `Review PR #${input.pr}: ${input.title}`,
    "",
    "## Description",
    input.description.trim().slice(0, 4000) || "(none)",
    "",
    "## Rules that apply to the changed files",
    ...applicable.map((r) =>
      [
        `### ${r.id} — ${r.title}`,
        `kind: ${r.kind} · severity: ${r.severity} · status: ${r.status} · paths: ${r.paths.join(", ") || "all files"}`,
        "",
        r.body,
        "",
      ].join("\n"),
    ),
    "## Diff",
    dropped.length ? `(omitted or truncated: ${dropped.join(", ")})` : "",
    "```diff",
    diffText,
    "```",
  ].join("\n");

  // Loaded before the sandbox exists so a missing prompt fails before git work.
  const systemPrompt = await loadPrompt("review");
  log(`review: sandbox at ${input.sha.slice(0, 12)} · diff ${kb(diffText.length)}${dropped.length ? ` (${dropped.length} dropped/truncated)` : ""}`);
  const out = await withSandbox(
    input.repoPath,
    input.sha,
    (dir) =>
      runAgent({
        agent: "review",
        pr: input.pr,
        model: config.models.review,
        systemPrompt,
        prompt,
        schema: ReviewOutputSchema,
        tools: ["Read", "Grep", "Glob"],
        sandboxRoot: dir,
        maxBudgetUsd: config.maxBudgetUsd,
        costs: opts.costs,
        log: opts.log,
      }),
    { pr: input.pr, inPlace: input.inPlace },
  );

  const lines = commentableLines(input.diff);
  const status = new Map(input.rules.map((r) => [r.id, r.status]));
  const known = new Set(input.rules.map((r) => r.id));
  const comments: CloneComment[] = [];
  for (const f of out.findings) {
    const ruleIds = f.ruleIds.filter((id) => known.has(id));
    const placement = placeFinding({ ...f, ruleIds }, { lines, status, threshold: config.postThreshold });
    if (placement === "drop") continue;
    const startOk = f.startLine !== null && f.startLine < f.line && (lines.get(f.path)?.has(f.startLine) ?? false);
    comments.push({
      ...f,
      ruleIds,
      startLine: startOk ? f.startLine : null,
      id: `clone:${comments.length + 1}`,
      placement,
    });
  }
  const inline = comments.filter((c) => c.placement === "inline").length;
  log(
    `review: ${out.findings.length} finding(s) → ${inline} inline, ${comments.length - inline} summary, ` +
      `${out.findings.length - comments.length} dropped · risk ${out.summary.risk}`,
  );

  return { ...base, comments, summary: out.summary };
}

/**
 * Reads the rules skill from a git ref instead of the working tree. In CI the
 * checkout is the PR head — reading rules from the base branch stops a PR
 * from silencing the pre-review by editing the rules it is reviewed against.
 */
export async function readRulesFromGit(repoPath: string, ref: string, skillPath: string): Promise<Rule[]> {
  const dir = `${skillPath.replace(/\/$/, "")}/rules/`;
  const { stdout } = await execa("git", ["-C", repoPath, "ls-tree", "--name-only", ref, dir]);
  const files = stdout.split("\n").filter((f) => f.endsWith(".md"));
  const rules: Rule[] = [];
  for (const file of files) {
    const { stdout: contents } = await execa("git", ["-C", repoPath, "show", `${ref}:${file}`]);
    const stem = file.slice(file.lastIndexOf("/") + 1, -3);
    rules.push(parseRule(contents, stem));
  }
  return rules;
}
