import type {
  Classification,
  CloneComment,
  DevComment,
  JudgeOutput,
  Meta,
} from "./schemas.js";
import { isConcern } from "./schemas.js";

/**
 * Turns judge verdicts into the numbers that answer "is the clone a useful
 * first reviewer?":
 *   - caught-first rate: share of the dev's real concerns the clone raised
 *   - achievable caught-first: same, excluding concerns that needed outside context
 *   - inline usefulness: share of inline clone comments that matched the dev
 *     or were valid on their own (what the dev would actually see)
 *   - noise per PR, and noise on PRs the dev passed without concerns
 */

export interface Sample {
  pr: number;
  path: string | null;
  line: number | null;
  body: string;
  reasoning: string;
}

export interface PrEval {
  pr: number;
  title: string;
  diffSource: Meta["diffSource"];
  /** Dev raised no concern (approved / only nits) — a precision test. */
  clean: boolean;
  concerns: number;
  achievableConcerns: number;
  caught: number;
  caughtAchievable: number;
  missed: { needs_context: number; learnable: number; new_concern: number };
  clone: { total: number; inline: number; matches: number; valid: number; noise: number; inlineNoise: number; inlineUseful: number };
  samples: { valid: Sample[]; noise: Sample[]; missedLearnable: Sample[]; caught: Sample[] };
}

export function evaluatePr(
  meta: Meta,
  dev: Array<{ comment: DevComment; classification: Classification }>,
  clone: CloneComment[],
  verdicts: JudgeOutput,
): PrEval {
  const devById = new Map(dev.map((d) => [d.comment.id, d]));
  const cloneById = new Map(clone.map((c) => [c.id, c]));
  const concernIds = new Set(dev.filter((d) => isConcern(d.classification)).map((d) => d.comment.id));
  const achievableIds = new Set(
    [...concernIds].filter((id) => !devById.get(id)!.classification.needsOutsideContext),
  );

  const e: PrEval = {
    pr: meta.number,
    title: meta.title,
    diffSource: meta.diffSource,
    clean: concernIds.size === 0,
    concerns: concernIds.size,
    achievableConcerns: achievableIds.size,
    caught: 0,
    caughtAchievable: 0,
    missed: { needs_context: 0, learnable: 0, new_concern: 0 },
    clone: { total: clone.length, inline: 0, matches: 0, valid: 0, noise: 0, inlineNoise: 0, inlineUseful: 0 },
    samples: { valid: [], noise: [], missedLearnable: [], caught: [] },
  };

  for (const v of verdicts.dev) {
    if (!concernIds.has(v.devCommentId)) continue;
    const d = devById.get(v.devCommentId)!.comment;
    const sample = { pr: meta.number, path: d.path, line: d.line, body: d.body, reasoning: v.reasoning };
    if (v.verdict === "caught") {
      e.caught++;
      if (achievableIds.has(v.devCommentId)) e.caughtAchievable++;
      e.samples.caught.push(sample);
    } else {
      const reason = v.missedReason ?? "learnable";
      e.missed[reason]++;
      if (reason === "learnable") e.samples.missedLearnable.push(sample);
    }
  }

  for (const v of verdicts.clone) {
    const c = cloneById.get(v.cloneId);
    if (!c) continue;
    const inline = c.placement === "inline";
    if (inline) e.clone.inline++;
    const sample = { pr: meta.number, path: c.path, line: c.line, body: c.body, reasoning: v.reasoning };
    if (v.verdict === "matches_dev") e.clone.matches++;
    if (v.verdict === "valid_unmentioned") {
      e.clone.valid++;
      e.samples.valid.push(sample);
    }
    if (v.verdict === "noise") {
      e.clone.noise++;
      if (inline) e.clone.inlineNoise++;
      e.samples.noise.push(sample);
    } else if (inline) {
      e.clone.inlineUseful++;
    }
  }
  return e;
}

export interface Aggregate {
  prs: number;
  cleanPrs: number;
  concerns: number;
  caught: number;
  caughtFirstRate: number | null;
  achievableCaughtFirstRate: number | null;
  inlineComments: number;
  inlineUsefulRate: number | null;
  allCommentsUsefulRate: number | null;
  noisePerPr: number;
  inlineNoisePerCleanPr: number | null;
  missed: PrEval["missed"];
  finalDiffPrs: number;
}

const ratio = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 100) / 100);

export function aggregate(evals: PrEval[]): Aggregate {
  const sum = (f: (e: PrEval) => number) => evals.reduce((s, e) => s + f(e), 0);
  const clean = evals.filter((e) => e.clean);
  const totalClone = sum((e) => e.clone.total);
  return {
    prs: evals.length,
    cleanPrs: clean.length,
    concerns: sum((e) => e.concerns),
    caught: sum((e) => e.caught),
    caughtFirstRate: ratio(sum((e) => e.caught), sum((e) => e.concerns)),
    achievableCaughtFirstRate: ratio(sum((e) => e.caughtAchievable), sum((e) => e.achievableConcerns)),
    inlineComments: sum((e) => e.clone.inline),
    inlineUsefulRate: ratio(sum((e) => e.clone.inlineUseful), sum((e) => e.clone.inline)),
    allCommentsUsefulRate: ratio(sum((e) => e.clone.matches + e.clone.valid), totalClone),
    noisePerPr: evals.length === 0 ? 0 : Math.round((sum((e) => e.clone.noise) / evals.length) * 100) / 100,
    inlineNoisePerCleanPr: clean.length === 0 ? null : Math.round((clean.reduce((s, e) => s + e.clone.inlineNoise, 0) / clean.length) * 100) / 100,
    missed: {
      needs_context: sum((e) => e.missed.needs_context),
      learnable: sum((e) => e.missed.learnable),
      new_concern: sum((e) => e.missed.new_concern),
    },
    finalDiffPrs: evals.filter((e) => e.diffSource === "final").length,
  };
}

const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);

function sampleList(title: string, samples: Sample[], max = 10): string[] {
  if (samples.length === 0) return [];
  return [
    `### ${title} (${samples.length}${samples.length > max ? `, showing ${max}` : ""})`,
    "",
    ...samples.slice(0, max).map(
      (s) =>
        `- **#${s.pr}** \`${s.path ?? "(PR-level)"}${s.line ? `:${s.line}` : ""}\` — ${oneLine(s.body)}\n  - _judge:_ ${oneLine(s.reasoning)}`,
    ),
    "",
  ];
}

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
};

export function renderReportMd(opts: {
  dev: string;
  repo: string;
  trainUntil: string;
  startedAt: string;
  costUsd: number;
  agg: Aggregate;
  evals: PrEval[];
}): string {
  const { agg, evals } = opts;
  const all = (k: keyof PrEval["samples"]) => evals.flatMap((e) => e.samples[k]);
  return [
    `# Watchtower evaluation — ${opts.dev} on ${opts.repo}`,
    "",
    `Held-out replay of ${agg.prs} PRs first reviewed on/after **${opts.trainUntil}** (rules learned only from earlier PRs).`,
    `Run started ${opts.startedAt} · model spend ≈ $${opts.costUsd}.`,
    "",
    "## Headline",
    "",
    "| Question | Result |",
    "|---|---|",
    `| Of the developer's real concerns, how many did the clone raise first? | **${pct(agg.caughtFirstRate)}** (${agg.caught}/${agg.concerns}) |`,
    `| …excluding concerns that needed outside context | **${pct(agg.achievableCaughtFirstRate)}** |`,
    `| Of the inline comments the developer would see, how many were useful? | **${pct(agg.inlineUsefulRate)}** (${agg.inlineComments} inline) |`,
    `| Useful share across all clone comments (incl. summary notes) | ${pct(agg.allCommentsUsefulRate)} |`,
    `| Noise per PR (all placements) | ${agg.noisePerPr} |`,
    `| Inline noise per clean PR (dev raised no concern) | ${agg.inlineNoisePerCleanPr ?? "n/a"} over ${agg.cleanPrs} clean PRs |`,
    `| Missed concerns: needs context / learnable / one-off | ${agg.missed.needs_context} / ${agg.missed.learnable} / ${agg.missed.new_concern} |`,
    "",
    "**How to read this.** \"Useful\" = the comment matched a developer concern, or the judge found it correct and verifiable",
    "though the developer didn't raise it. That second bucket is LLM-judged: skim the samples below and confirm them yourself",
    "before trusting the number. Missed *learnable* concerns are what the next learning pass should target.",
    agg.finalDiffPrs > 0
      ? `\n⚠️ ${agg.finalDiffPrs} PR(s) were replayed on the final diff (reviewed commit unavailable); their caught/missed numbers are less reliable.`
      : "",
    "",
    "## Per PR",
    "",
    "| PR | Concerns | Caught | Inline | Useful inline | Noise | Clean |",
    "|---|---|---|---|---|---|---|",
    ...evals.map(
      (e) =>
        `| #${e.pr} ${oneLine(e.title).slice(0, 60)} | ${e.concerns} | ${e.caught} | ${e.clone.inline} | ${e.clone.inlineUseful} | ${e.clone.noise} | ${e.clean ? "yes" : ""} |`,
    ),
    "",
    "## Samples to spot-check",
    "",
    ...sampleList("Valid but unmentioned by the developer — confirm these are really useful", all("valid")),
    ...sampleList("Noise — what the clone should stop saying", all("noise")),
    ...sampleList("Missed learnable concerns", all("missedLearnable")),
    ...sampleList("Caught first", all("caught")),
  ].join("\n");
}
