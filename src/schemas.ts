import { z } from "zod";

/**
 * Zod schemas for the files watchtower writes (see SCHEMAS.md).
 * Types are inferred from the schemas so there is one source of truth.
 */

// ── cache/prs/<pr#>/meta.json ────────────────────────────────────────────────

export const PrFileSchema = z.object({
  path: z.string(),
  status: z.string(), // added | modified | removed | renamed | ...
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const MetaSchema = z.object({
  schemaVersion: z.literal(1),
  number: z.number().int().positive(),
  repo: z.string(),
  title: z.string(),
  author: z.string(),
  state: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  files: z.array(PrFileSchema),
});

export type Meta = z.infer<typeof MetaSchema>;

// ── truth/<pr#>/review_comments.json ─────────────────────────────────────────

export const CommentSide = z.enum(["RIGHT", "LEFT"]);

export const ReviewCommentSchema = z.object({
  id: z.string(), // "gh:<review-comment-id>"
  path: z.string(),
  line: z.number().int().nullable(),
  startLine: z.number().int().nullable(),
  side: CommentSide,
  diffHunk: z.string(),
  body: z.string(),
  inReplyToId: z.string().nullable(),
  createdAt: z.string(),
  url: z.string(),
});

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const ReviewCommentsFileSchema = z.object({
  schemaVersion: z.literal(1),
  pr: z.number().int().positive(),
  repo: z.string(),
  reviewer: z.string(),
  comments: z.array(ReviewCommentSchema),
});

export type ReviewCommentsFile = z.infer<typeof ReviewCommentsFileSchema>;

// ── reviews/<pr#>/clone_comments.json (written by the review agent) ───────────

export const CloneCommentSchema = z.object({
  id: z.string(), // "clone:<n>"
  path: z.string(),
  line: z.number().int().nullable(),
  startLine: z.number().int().nullable(),
  side: CommentSide,
  body: z.string(),
  policyIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export type CloneComment = z.infer<typeof CloneCommentSchema>;

export const CloneCommentsFileSchema = z.object({
  schemaVersion: z.literal(1),
  pr: z.number().int().positive(),
  repo: z.string(),
  generatedAt: z.string(),
  policyVersion: z.string(),
  comments: z.array(CloneCommentSchema),
});

export type CloneCommentsFile = z.infer<typeof CloneCommentsFileSchema>;
