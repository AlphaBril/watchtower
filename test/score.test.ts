import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, evaluatePr } from "../src/score.js";
import type { Classification, CloneComment, DevComment, Meta } from "../src/schemas.js";

const meta = (n: number): Meta => ({
  schemaVersion: 2, number: n, repo: "o/r", title: `PR ${n}`, body: "", author: "a", state: "closed",
  baseSha: "b", headSha: "h", createdAt: "2026-01-01", mergedAt: null, reviewedSha: "r", reviewedAt: "2026-01-02",
  devReviewStates: ["COMMENTED"], diffSource: "reviewed", files: [],
});

const dev = (id: string, cls: Partial<Classification> = {}) => ({
  comment: {
    id, kind: "inline", path: "a.ts", line: 1, startLine: null, side: "RIGHT", diffHunk: "", body: id,
    inReplyToId: null, originalCommitId: "r", createdAt: "", url: "",
  } as DevComment,
  classification: { id, category: "actionable", severity: "should", needsOutsideContext: false, gist: id, ...cls } as Classification,
});

const clone = (id: string, placement: CloneComment["placement"] = "inline"): CloneComment => ({
  id, path: "a.ts", line: 1, startLine: null, body: id, ruleIds: [], severity: "should", confidence: 0.9, placement,
});

test("evaluatePr: caught/missed only over concerns; nits ignored for recall", () => {
  const devs = [dev("gh:1"), dev("gh:2", { needsOutsideContext: true }), dev("gh:3", { category: "nit", severity: "nit" })];
  const clones = [clone("clone:1"), clone("clone:2"), clone("clone:3", "summary")];
  const e = evaluatePr(meta(1), devs, clones, {
    dev: [
      { devCommentId: "gh:1", verdict: "caught", cloneId: "clone:1", missedReason: null, reasoning: "" },
      { devCommentId: "gh:2", verdict: "missed", cloneId: null, missedReason: "needs_context", reasoning: "" },
      { devCommentId: "gh:3", verdict: "missed", cloneId: null, missedReason: "learnable", reasoning: "" },
    ],
    clone: [
      { cloneId: "clone:1", verdict: "matches_dev", devCommentId: "gh:1", reasoning: "" },
      { cloneId: "clone:2", verdict: "noise", devCommentId: null, reasoning: "" },
      { cloneId: "clone:3", verdict: "valid_unmentioned", devCommentId: null, reasoning: "" },
    ],
  });
  assert.equal(e.concerns, 2);
  assert.equal(e.achievableConcerns, 1);
  assert.equal(e.caught, 1);
  assert.equal(e.caughtAchievable, 1);
  assert.deepEqual(e.missed, { needs_context: 1, learnable: 0, new_concern: 0 });
  assert.deepEqual(e.clone, { total: 3, inline: 2, matches: 1, valid: 1, noise: 1, inlineNoise: 1, inlineUseful: 1 });
  assert.equal(e.clean, false);
});

test("aggregate: rates and clean-PR noise", () => {
  const busy = evaluatePr(meta(1), [dev("gh:1")], [clone("clone:1")], {
    dev: [{ devCommentId: "gh:1", verdict: "caught", cloneId: "clone:1", missedReason: null, reasoning: "" }],
    clone: [{ cloneId: "clone:1", verdict: "matches_dev", devCommentId: "gh:1", reasoning: "" }],
  });
  const cleanNoisy = evaluatePr(meta(2), [], [clone("clone:1"), clone("clone:2")], {
    dev: [],
    clone: [
      { cloneId: "clone:1", verdict: "noise", devCommentId: null, reasoning: "" },
      { cloneId: "clone:2", verdict: "valid_unmentioned", devCommentId: null, reasoning: "" },
    ],
  });
  const agg = aggregate([busy, cleanNoisy]);
  assert.equal(agg.caughtFirstRate, 1);
  assert.equal(agg.cleanPrs, 1);
  assert.equal(agg.inlineNoisePerCleanPr, 1);
  assert.equal(agg.inlineUsefulRate, 0.67);
  assert.equal(agg.noisePerPr, 0.5);
  assert.equal(aggregate([]).caughtFirstRate, null);
});
