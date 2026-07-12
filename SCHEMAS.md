# Watchtower ↔ pi — File Schemas

These files are the contract between **watchtower** (writes cache/truth/judge-pending, reads reviews/judgments)
and the **pi** agents `learn` / `review` / `judge` (see `.pi/agents/watchtower/`).
Draft v0 — reconcile with the agent prompts, which already declare their own shapes.

All files are UTF-8 JSON. Line numbers refer to the PR **head** side of the diff unless
`side` says otherwise. A `null` line means the comment is file-level (not line-anchored).

---

## `cache/prs/<pr#>/meta.json`
Written by watchtower. Read by `pi review` and `pi learn`.

```json
{
  "schemaVersion": 1,
  "number": 1234,
  "repo": "owner/repo",
  "title": "Add retry logic to the uploader",
  "author": "pr-author-login",
  "state": "closed",
  "baseSha": "a1b2c3…",
  "headSha": "d4e5f6…",
  "createdAt": "2026-05-01T10:00:00Z",
  "mergedAt": "2026-05-02T12:00:00Z",
  "files": [
    { "path": "src/uploader.ts", "status": "modified", "additions": 40, "deletions": 3 }
  ]
}
```

## `cache/prs/<pr#>/diff.patch`
Written by watchtower. Raw unified diff for the whole PR (GitHub `.diff`). Plain text, not JSON.

---

## `truth/<pr#>/review_comments.json`
The **real developer's** review comments. Written by watchtower.
Read by `pi learn`. **Never** exposed to `pi review` (structural isolation).

```json
{
  "schemaVersion": 1,
  "pr": 1234,
  "repo": "owner/repo",
  "reviewer": "target-dev-login",
  "comments": [
    {
      "id": "gh:998877",
      "path": "src/uploader.ts",
      "line": 42,
      "startLine": null,
      "side": "RIGHT",
      "diffHunk": "@@ -38,6 +38,11 @@ export async function upload(...) {\n+  for (let i = 0; i < 3; i++) {",
      "body": "Don't hard-code the retry count — pull it from config so ops can tune it.",
      "inReplyToId": null,
      "createdAt": "2026-05-01T15:30:00Z",
      "url": "https://github.com/owner/repo/pull/1234#discussion_r998877"
    }
  ]
}
```

Field notes:
- `id` — stable, namespaced (`gh:` + GitHub review-comment id).
- `line` / `startLine` — head-side line; `startLine` non-null only for multi-line comments.
- `side` — `RIGHT` (head) or `LEFT` (base).
- `diffHunk` — the hunk GitHub anchors the comment to; gives pi the local code context.
- `inReplyToId` — set when the comment is a threaded reply (helps filter discussion).

---

## `reviews/<pr#>/clone_comments.json`
The **clone's** generated comments. Written by `pi review`. Read by watchtower for scoring.
Deliberately the **same shape** as `truth` comments so matching is apples-to-apples.

```json
{
  "schemaVersion": 1,
  "pr": 1234,
  "repo": "owner/repo",
  "generatedAt": "2026-07-09T09:00:00Z",
  "policyVersion": "policies@<hash-or-timestamp>",
  "comments": [
    {
      "id": "clone:1",
      "path": "src/uploader.ts",
      "line": 42,
      "startLine": null,
      "side": "RIGHT",
      "body": "Retry count is hard-coded to 3; consider making it configurable.",
      "policyIds": ["no-magic-numbers", "config-over-constants"],
      "confidence": 0.82
    }
  ]
}
```

Field notes:
- `id` — namespaced `clone:` + local counter.
- `policyIds` — which policy file(s) triggered this comment (slugs of `policies/<slug>.md`).
- `confidence` — pi's self-rated confidence [0,1]; feeds watchtower's flag threshold.
- No `diffHunk` required from pi (it read the diff itself), but it may include it.

---

## `policies/<slug>.md`
Written/updated by `pi learn`, read by `pi review`. Human-readable + diffable.
Suggested front-matter so watchtower can index them without parsing prose:

```markdown
---
id: no-magic-numbers
title: Prefer named/config values over magic numbers
sourceComments: ["gh:998877", "gh:998901"]
confidence: 0.6
validationScore: null
version: 1
createdFromPr: 1234
---

When a numeric literal controls behavior (retries, timeouts, limits), the developer
flags it and asks for a named constant or a config value. Applies to control-flow and
tuning knobs, not to obvious constants like array index 0 or `* 2`.
```

## `judge/pending/<pr#>/pairs.json`
Written by watchtower after the deterministic matcher runs. Read by the `judge` agent.
Contains only what the deterministic matcher could NOT confidently resolve.

```json
{
  "schemaVersion": 1,
  "pr": 1234,
  "repo": "owner/repo",
  "generatedAt": "2026-07-09T09:00:00Z",
  "pairs": [
    {
      "pairId": "p1",
      "truth": { "id": "gh:998877", "path": "src/uploader.ts", "line": 42, "body": "…" },
      "clone": { "id": "clone:1", "path": "src/uploader.ts", "line": 42, "body": "…", "policyIds": ["no-magic-numbers"], "confidence": 0.82 }
    }
  ],
  "unmatched_truth": [ { "id": "gh:998901", "path": "src/uploader.ts", "line": 67, "body": "…" } ],
  "unmatched_clone": [ { "id": "clone:4", "path": "src/uploader.ts", "line": 55, "body": "…", "policyIds": ["extract-helpers"], "confidence": 0.45 } ]
}
```

- `pairs` — candidate matches (same file, nearby lines) the deterministic scorer couldn't call via keyword overlap.
- `unmatched_truth` / `unmatched_clone` — comments with no deterministic match; judge cross-checks for paraphrase recoveries.

## `judge/results/<pr#>/judgments.json`
Written by the `judge` agent. Read by watchtower to finalize scores.

```json
{
  "schemaVersion": 1,
  "pr": 1234,
  "judgedAt": "2026-07-09T09:05:00Z",
  "pairJudgments": [
    {
      "pairId": "p1",
      "verdict": "match",
      "score": 0.92,
      "reasoning": "Both flag the hard-coded retry count; same fix.",
      "dimensions": { "sameConcern": true, "sameLocation": true, "sameFix": true, "sameSeverity": true }
    }
  ],
  "recoveredMatches": [
    { "truthId": "gh:998901", "cloneId": "clone:4", "score": 0.0, "reasoning": "Different concerns." }
  ],
  "summary": {
    "pairsJudged": 1, "matchCount": 1, "partialCount": 0, "noMatchCount": 0,
    "recoveredCount": 0, "unmatchableTruth": ["gh:998901"], "unmatchableClone": ["clone:4"]
  }
}
```

- `verdict` ∈ `match` (0.75–1.0) | `partial` (0.4–0.74) | `no_match` (0.0–0.39).
- `recoveredMatches` — semantic matches (score ≥ 0.6) the deterministic matcher missed; watchtower folds these back into precision/recall.

## `runs/<timestamp>/report.json`
Written by watchtower only. pi does not read it.

```json
{
  "schemaVersion": 1,
  "startedAt": "2026-07-09T09:00:00Z",
  "prs": [
    {
      "pr": 1234,
      "iterations": 2,
      "precision": 0.71,
      "recall": 0.66,
      "falsePositives": 2,
      "matched": [ { "trueId": "gh:998877", "cloneId": "clone:1", "score": 0.8 } ],
      "missed": ["gh:998901"],
      "extra": ["clone:4"],
      "decision": "validated"
    }
  ]
}
```

`decision` ∈ `validated` | `iterate` | `flagged`.
