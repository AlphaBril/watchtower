import { loadPrompt, runAgent, type CostLog } from "./agent.js";
import { kb, silent, type Log } from "./log.js";
import { classifyPr } from "./classify.js";
import { skillName, type Config } from "./config.js";
import { filterDiff } from "./diff.js";
import { writeJson } from "./fsutil.js";
import { watchtowerPaths } from "./paths.js";
import { syncPersonalSkill } from "./personal.js";
import {
  applicableRules,
  applyLearnOps,
  readRules,
  writeRule,
  writeSkillIndex,
} from "./rules.js";
import { LedgerSchema, LearnOutputSchema, isSignal, type Ledger } from "./schemas.js";
import { readDiff, readMeta, readTruth, readValidatedOr } from "./store.js";

/**
 * Learns from one PR: classify its dev comments, keep the signal ones not
 * already in the ledger, and let the learn agent turn them into rule
 * operations, which watchtower validates and writes to the local skill.
 *
 * The ledger makes this idempotent: re-running never re-feeds a comment, so
 * rules don't accumulate duplicate sources.
 */

export function readLedger(): Promise<Ledger> {
  return readValidatedOr(watchtowerPaths().ledger, LedgerSchema, "ledger.json", {
    schemaVersion: 1,
    learned: {},
  });
}

export interface LearnSummary {
  pr: number;
  newComments: number;
  created: string[];
  updated: string[];
  skipped: Array<{ commentId: string; reason: string }>;
  rejected: Array<{ id: string; reason: string }>;
}

export async function learnPr(
  pr: number,
  config: Config,
  opts: { costs?: CostLog; log?: Log } = {},
): Promise<LearnSummary | null> {
  const paths = watchtowerPaths();
  const skillDir = paths.skillDir(skillName(config));

  const log = opts.log ?? silent;
  const classified = await classifyPr(pr, config, { costs: opts.costs, log });
  const ledger = await readLedger();
  const signal = classified.items.filter(isSignal);
  const fresh = signal.filter((i) => !(i.id in ledger.learned));
  log(
    `signal: ${signal.length} of ${classified.items.length} comment(s)` +
      (signal.length > fresh.length ? ` · ${signal.length - fresh.length} already learned` : ""),
  );
  if (fresh.length === 0) return null;

  const [meta, truth, rawDiff, rules] = await Promise.all([
    readMeta(pr),
    readTruth(pr),
    readDiff(pr),
    readRules(skillDir),
  ]);
  const commentById = new Map(truth.comments.map((c) => [c.id, c]));
  const related = applicableRules(rules, meta.files.map((f) => f.path));

  const input = {
    pr: { number: meta.number, title: meta.title, description: meta.body.slice(0, 4000) },
    comments: fresh.map((c) => {
      const raw = commentById.get(c.id)!;
      return {
        id: c.id,
        kind: raw.kind,
        path: raw.path,
        line: raw.line,
        body: raw.body,
        diffHunk: raw.diffHunk.slice(-1500),
        classification: { category: c.category, severity: c.severity, needsOutsideContext: c.needsOutsideContext, gist: c.gist },
      };
    }),
    ruleIndex: rules
      .filter((r) => r.status !== "retired")
      .map((r) => ({ id: r.id, title: r.title, kind: r.kind, paths: r.paths })),
    relatedRules: related.map((r) => ({ id: r.id, title: r.title, kind: r.kind, severity: r.severity, paths: r.paths, body: r.body })),
  };

  const diff = filterDiff(rawDiff, 80_000);
  log(
    `context: diff ${kb(rawDiff.length)} → ${kb(diff.text.length)}` +
      (diff.dropped.length ? ` (${diff.dropped.length} file(s) dropped/truncated)` : "") +
      ` · ${rules.length} rule(s) indexed, ${related.length} related`,
  );
  const prompt = [
    "Learn rules from these review comments.",
    "",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
    "",
    `Diff at the commit the developer reviewed (${meta.diffSource === "reviewed" ? meta.reviewedSha.slice(0, 12) : "final PR diff — reviewed commit unavailable"}):`,
    "",
    "```diff",
    diff.text,
    "```",
  ].join("\n");

  const out = await runAgent({
    agent: "learn",
    pr,
    model: config.models.learn,
    systemPrompt: await loadPrompt("learn"),
    prompt,
    schema: LearnOutputSchema,
    maxBudgetUsd: config.maxBudgetUsd,
    costs: opts.costs,
    log: opts.log,
  });

  const { rules: next, result } = applyLearnOps(rules, out.operations, new Set(fresh.map((c) => c.id)));
  const changed = new Set([...result.created, ...result.updated]);
  for (const rule of next) if (changed.has(rule.id)) await writeRule(skillDir, rule);
  await writeSkillIndex(skillDir, { name: skillName(config), dev: config.targetDev, repo: config.repo, rules: next });
  if (await syncPersonalSkill(skillDir, skillName(config))) log("synced personal skill");
  for (const id of result.created) log(`+ ${id}`);
  for (const id of result.updated) log(`~ ${id}`);

  // Record every fresh comment — learned, skipped or rejected — so it is
  // never re-fed. Use `watchtower learn --forget <pr>` to retry a PR.
  const at = new Date().toISOString();
  for (const c of fresh) {
    ledger.learned[c.id] = { pr, at, ruleIds: result.bySource.get(c.id) ?? [] };
  }
  await writeJson(paths.ledger, ledger);

  return {
    pr,
    newComments: fresh.length,
    created: result.created,
    updated: result.updated,
    skipped: out.skipped,
    rejected: result.rejected,
  };
}

/** Removes a PR's comments from the ledger so the next learn re-processes them. */
export async function forgetPr(pr: number): Promise<number> {
  const ledger = await readLedger();
  const ids = Object.entries(ledger.learned).filter(([, v]) => v.pr === pr).map(([id]) => id);
  for (const id of ids) delete ledger.learned[id];
  await writeJson(watchtowerPaths().ledger, ledger);
  return ids.length;
}
