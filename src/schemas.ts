import { z } from "zod";

/**
 * Zod schemas for every file watchtower reads/writes and every agent's
 * structured output (see SCHEMAS.md). Types are inferred from the schemas so
 * there is one source of truth; agent output schemas are also converted to
 * JSON Schema and handed to the Agent SDK (`outputFormat`).
 *
 * Agent-output schemas deliberately avoid defaults, unions and optional keys
 * (nullable instead) so their JSON Schema stays simple for structured output.
 */

// ── cache/prs/<pr#>/meta.json ────────────────────────────────────────────────

export const PrFileSchema = z.object({
  path: z.string(),
  status: z.string(), // added | modified | removed | renamed | ...
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const MetaSchema = z.object({
  schemaVersion: z.literal(2),
  number: z.number().int().positive(),
  repo: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  state: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  /** Commit the dev's FIRST review was made on — what we replay. */
  reviewedSha: z.string(),
  /** When the dev's first review was submitted (train/test split key). */
  reviewedAt: z.string().nullable(),
  /** States of every review the dev submitted (APPROVED, COMMENTED, ...). */
  devReviewStates: z.array(z.string()),
  /** `reviewed` = diff base…reviewedSha; `final` = fallback to the PR's final diff. */
  diffSource: z.enum(["reviewed", "final"]),
  files: z.array(PrFileSchema),
});

export type Meta = z.infer<typeof MetaSchema>;

// ── truth/<pr#>/review_comments.json ─────────────────────────────────────────

export const CommentSide = z.enum(["RIGHT", "LEFT"]);

export const DevCommentSchema = z.object({
  /** `gh:<id>` inline, `gh-review:<id>` review body, `gh-issue:<id>` PR conversation. */
  id: z.string(),
  kind: z.enum(["inline", "review", "conversation"]),
  path: z.string().nullable(),
  /** Line on the commit the comment was made on (GitHub `original_line`). */
  line: z.number().int().nullable(),
  startLine: z.number().int().nullable(),
  side: CommentSide,
  diffHunk: z.string(),
  body: z.string(),
  inReplyToId: z.string().nullable(),
  originalCommitId: z.string().nullable(),
  createdAt: z.string(),
  url: z.string(),
});

export type DevComment = z.infer<typeof DevCommentSchema>;

export const ReviewCommentsFileSchema = z.object({
  schemaVersion: z.literal(2),
  pr: z.number().int().positive(),
  repo: z.string(),
  reviewer: z.string(),
  comments: z.array(DevCommentSchema),
});

export type ReviewCommentsFile = z.infer<typeof ReviewCommentsFileSchema>;

// ── classify agent output → truth/<pr#>/classified.json ──────────────────────

export const CommentCategory = z.enum([
  "actionable", // asks for a change
  "question", // challenges a change ("why did you remove…?") — usually a concern
  "nit", // cosmetic / optional
  "retraction", // takes back an earlier remark ("my bad", "finalement non")
  "reply", // discussion within a thread
  "praise",
]);
export type CommentCategory = z.infer<typeof CommentCategory>;

export const Severity = z.enum(["blocker", "should", "nit"]);
export type Severity = z.infer<typeof Severity>;

export const ClassificationSchema = z.object({
  id: z.string(),
  category: CommentCategory,
  severity: Severity,
  /** True when the concern can't be derived from the code alone (product decision, meeting, roadmap). */
  needsOutsideContext: z.boolean(),
  /** One-line neutral restatement of the concern, in English. */
  gist: z.string(),
});

export type Classification = z.infer<typeof ClassificationSchema>;

export const ClassifyOutputSchema = z.object({
  items: z.array(ClassificationSchema),
});

export const ClassifiedFileSchema = z.object({
  schemaVersion: z.literal(1),
  pr: z.number().int().positive(),
  items: z.array(ClassificationSchema),
});

export type ClassifiedFile = z.infer<typeof ClassifiedFileSchema>;

/** Dev comments that are a concern the clone should try to raise first. */
export const isConcern = (c: Classification) =>
  (c.category === "actionable" || c.category === "question") && c.severity !== "nit";

/** Dev comments worth learning from / judging against (drops noise categories). */
export const isSignal = (c: Classification) =>
  c.category === "actionable" || c.category === "question" || c.category === "nit";

// ── rules (skill/<name>/rules/<id>.md frontmatter) ───────────────────────────

export const RuleKind = z.enum(["invariant", "convention", "taste"]);
export const RuleStatus = z.enum(["probation", "active", "retired"]);
export const SOURCE_COMMENT_RE = /^gh(-review|-issue)?:\d+$/;
export const RULE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const RuleSchema = z.object({
  id: z.string().regex(RULE_ID_RE, "id must be kebab-case"),
  title: z.string().min(1),
  kind: RuleKind,
  severity: Severity,
  /** Globs (repo-relative) the rule applies to; empty = everywhere. */
  paths: z.array(z.string().min(1)),
  sourceComments: z.array(z.string().regex(SOURCE_COMMENT_RE)).min(1),
  status: RuleStatus,
  body: z.string().min(1),
});

export type Rule = z.infer<typeof RuleSchema>;

// ── learn agent output ───────────────────────────────────────────────────────

export const LearnOperationSchema = z.object({
  op: z.enum(["create", "update"]),
  /** New kebab-case id for create; existing id for update. */
  id: z.string(),
  /** create: required. update: null keeps the current value. */
  title: z.string().nullable(),
  kind: RuleKind.nullable(),
  severity: Severity.nullable(),
  paths: z.array(z.string()).nullable(),
  /** Body prose. update: null keeps the current body. */
  body: z.string().nullable(),
  /** Dev comment ids this operation is grounded in. */
  sourceComments: z.array(z.string()),
});

export type LearnOperation = z.infer<typeof LearnOperationSchema>;

export const LearnOutputSchema = z.object({
  operations: z.array(LearnOperationSchema),
  skipped: z.array(z.object({ commentId: z.string(), reason: z.string() })),
});

export type LearnOutput = z.infer<typeof LearnOutputSchema>;

// ── review agent output → reviews/<pr#>/review.json ──────────────────────────

export const ReviewFindingSchema = z.object({
  path: z.string(),
  /** HEAD-side line the comment anchors to. */
  line: z.number().int(),
  startLine: z.number().int().nullable(),
  body: z.string(),
  /** Rules that triggered this finding; empty = a clear defect no rule covers. */
  ruleIds: z.array(z.string()),
  severity: Severity,
  confidence: z.number().min(0).max(1),
});

export const ReviewSummarySchema = z.object({
  risk: z.enum(["low", "medium", "high"]),
  overview: z.string(),
  /** Where the dev's own judgment is needed — what the clone can't decide. */
  needsHumanJudgment: z.array(z.object({ area: z.string(), why: z.string() })),
});

export const ReviewOutputSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  summary: ReviewSummarySchema,
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const CloneCommentSchema = ReviewFindingSchema.extend({
  id: z.string(), // "clone:<n>"
  /** `inline` = posted on the line; `summary` = folded into the review body. */
  placement: z.enum(["inline", "summary"]),
});

export type CloneComment = z.infer<typeof CloneCommentSchema>;

export const ReviewFileSchema = z.object({
  schemaVersion: z.literal(2),
  pr: z.number().int().positive(),
  repo: z.string(),
  sha: z.string(),
  generatedAt: z.string(),
  rulesApplied: z.array(z.string()),
  comments: z.array(CloneCommentSchema),
  summary: ReviewSummarySchema,
});

export type ReviewFile = z.infer<typeof ReviewFileSchema>;

// ── compact: duplicate-grouping agent output ─────────────────────────────────

export const GroupOutputSchema = z.object({
  groups: z.array(z.object({ concern: z.string(), ids: z.array(z.string()) })),
});

export type GroupOutput = z.infer<typeof GroupOutputSchema>;

// ── compact: merge agent output ──────────────────────────────────────────────

export const MergeOutputSchema = z.object({
  merges: z.array(
    z.object({
      /** Rule ids folded into this one (≥2, all from the given cluster). */
      from: z.array(z.string()),
      id: z.string(),
      title: z.string(),
      kind: RuleKind,
      severity: Severity,
      paths: z.array(z.string()),
      body: z.string(),
    }),
  ),
});

export type MergeOutput = z.infer<typeof MergeOutputSchema>;

// ── compact: repo audit agent output ─────────────────────────────────────────

export const ToolingKind = z.enum(["eslint", "typescript", "custom-lint-rule", "ci-check", "codemod", "other"]);

export const AuditOutputSchema = z.object({
  /** The code pattern the rule is about actually occurs in its scope. */
  applies: z.boolean(),
  checked: z.number().int().nonnegative(),
  conforming: z.number().int().nonnegative(),
  violating: z.number().int().nonnegative(),
  examples: z.array(
    z.object({ path: z.string(), line: z.number().int().nullable(), conforms: z.boolean(), note: z.string() }),
  ),
  /** Already enforced by existing tooling (lint config, compiler, CI, shared helper). */
  alreadyEnforced: z.boolean(),
  alreadyEnforcedBy: z.string().nullable(),
  /** Could tooling enforce it instead of a reviewer? */
  tooling: z.object({
    feasible: z.boolean(),
    kind: ToolingKind.nullable(),
    summary: z.string().nullable(),
    /** Concrete change: config snippet, rule code, CI step — ready to adapt. */
    implementation: z.string().nullable(),
    effort: z.enum(["low", "medium", "high"]).nullable(),
  }),
  /** Narrower/corrected globs when the current `paths` are wrong or too broad; null = keep. */
  suggestedPaths: z.array(z.string()).nullable(),
  verdict: z.enum(["keep", "rescope", "drop"]),
  reason: z.string(),
});

export type AuditOutput = z.infer<typeof AuditOutputSchema>;

// ── judge agent output ───────────────────────────────────────────────────────

export const JudgeOutputSchema = z.object({
  clone: z.array(
    z.object({
      cloneId: z.string(),
      verdict: z.enum(["matches_dev", "valid_unmentioned", "noise"]),
      devCommentId: z.string().nullable(),
      reasoning: z.string(),
    }),
  ),
  dev: z.array(
    z.object({
      devCommentId: z.string(),
      verdict: z.enum(["caught", "missed"]),
      cloneId: z.string().nullable(),
      missedReason: z.enum(["needs_context", "new_concern", "learnable"]).nullable(),
      reasoning: z.string(),
    }),
  ),
});

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

// ── ledger.json — dev comments already learned from ──────────────────────────

export const LedgerSchema = z.object({
  schemaVersion: z.literal(1),
  learned: z.record(
    z.string(),
    z.object({ pr: z.number().int(), at: z.string(), ruleIds: z.array(z.string()) }),
  ),
});

export type Ledger = z.infer<typeof LedgerSchema>;

// ── stats/rules.json — production feedback per posted clone comment ──────────

export const StatsSchema = z.object({
  schemaVersion: z.literal(1),
  /** Keyed by GitHub review-comment id of the bot's inline comment. */
  comments: z.record(
    z.string(),
    z.object({
      pr: z.number().int(),
      ruleIds: z.array(z.string()),
      reaction: z.enum(["up", "down"]).nullable(),
      postedAt: z.string(),
    }),
  ),
});

export type Stats = z.infer<typeof StatsSchema>;

// ── candidates.json — PRs with fresh dev comments to learn from ──────────────

export const CandidatesSchema = z.object({
  schemaVersion: z.literal(1),
  prs: z.array(z.number().int().positive()),
});
