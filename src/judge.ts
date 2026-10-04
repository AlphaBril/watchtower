import { loadPrompt, runAgent, type CostLog } from "./agent.js";
import { silent, type Log } from "./log.js";
import type { Config } from "./config.js";
import { filterDiff } from "./diff.js";
import { candidatePairs } from "./match.js";
import {
  JudgeOutputSchema,
  type Classification,
  type CloneComment,
  type DevComment,
  type JudgeOutput,
} from "./schemas.js";

/**
 * Judges the clone's comments against the dev's comments on the same PR at
 * the same commit: every clone comment → matches_dev | valid_unmentioned |
 * noise; every dev comment → caught | missed (+ why).
 */
export async function judgePr(
  input: {
    pr: number;
    title: string;
    diff: string;
    dev: Array<{ comment: DevComment; classification: Classification }>;
    clone: CloneComment[];
  },
  config: Config,
  opts: { costs?: CostLog; log?: Log } = {},
): Promise<JudgeOutput> {
  // No clone comments: nothing to judge on that side, and the missed reason
  // follows from classification — skip the model call.
  if (input.clone.length === 0) {
    (opts.log ?? silent)(`judge: skipped (no clone comments) · ${input.dev.length} dev comment(s) counted as missed`);
    return {
      clone: [],
      dev: input.dev.map(({ comment, classification }) => ({
        devCommentId: comment.id,
        verdict: "missed",
        cloneId: null,
        missedReason: classification.needsOutsideContext ? "needs_context" : "learnable",
        reasoning: "The clone made no comments on this PR.",
      })),
    };
  }

  const payload = {
    pr: input.pr,
    title: input.title,
    devComments: input.dev.map(({ comment, classification }) => ({
      id: comment.id,
      path: comment.path,
      line: comment.line,
      body: comment.body,
      gist: classification.gist,
      severity: classification.severity,
    })),
    cloneComments: input.clone.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line,
      body: c.body,
      severity: c.severity,
      confidence: c.confidence,
    })),
    likelyPairs: candidatePairs(
      input.dev.map(({ comment }) => comment),
      input.clone,
    ).slice(0, 30),
  };

  const out = await runAgent({
    agent: "judge",
    pr: input.pr,
    model: config.models.judge,
    systemPrompt: await loadPrompt("judge"),
    prompt: [
      "Judge the clone against the developer.",
      "",
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
      "",
      "Diff under review:",
      "```diff",
      filterDiff(input.diff, 80_000).text,
      "```",
    ].join("\n"),
    schema: JudgeOutputSchema,
    maxBudgetUsd: config.maxBudgetUsd,
    costs: opts.costs,
    log: opts.log,
  });

  return reconcile(input, out);
}

/** Exactly one verdict per given id; missing ones become conservative defaults. */
function reconcile(
  input: { dev: Array<{ comment: DevComment }>; clone: CloneComment[] },
  out: JudgeOutput,
): JudgeOutput {
  const cloneV = new Map(out.clone.map((v) => [v.cloneId, v]));
  const devV = new Map(out.dev.map((v) => [v.devCommentId, v]));
  return {
    clone: input.clone.map(
      (c) =>
        cloneV.get(c.id) ?? { cloneId: c.id, verdict: "noise", devCommentId: null, reasoning: "Not judged (missing from judge output)." },
    ),
    dev: input.dev.map(
      ({ comment }) =>
        devV.get(comment.id) ?? {
          devCommentId: comment.id,
          verdict: "missed",
          cloneId: null,
          missedReason: "learnable",
          reasoning: "Not judged (missing from judge output).",
        },
    ),
  };
}
