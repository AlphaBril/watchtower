# Watchtower — File & Agent Schemas (v2)

The authoritative definitions are the zod schemas in [`src/schemas.ts`](src/schemas.ts); agent
output schemas are converted to JSON Schema (`z.toJSONSchema`) and passed to the Agent SDK as
`outputFormat`. This page summarizes them.

Agents never write files. Every agent returns structured output; watchtower validates it and
writes the files below.

## `cache/prs/<pr#>/meta.json` (v2)

```json
{
  "schemaVersion": 2, "number": 3055, "repo": "owner/repo", "title": "…", "body": "…",
  "author": "login", "state": "closed", "baseSha": "…", "headSha": "…",
  "createdAt": "…", "mergedAt": "…",
  "reviewedSha": "…",          // commit of the dev's first review — what is replayed
  "reviewedAt": "…",           // train/test split key
  "devReviewStates": ["COMMENTED", "APPROVED"],
  "diffSource": "reviewed",    // or "final" when the reviewed commit is gone
  "files": [{ "path": "…", "status": "modified", "additions": 1, "deletions": 0 }]
}
```

`diff.patch` is the unified diff `base…reviewedSha` (or the final PR diff when `diffSource: final`).

## `truth/<pr#>/review_comments.json` (v2)

```json
{ "schemaVersion": 2, "pr": 3055, "repo": "owner/repo", "reviewer": "login",
  "comments": [{
    "id": "gh:3396524691",     // gh: inline · gh-review: review body · gh-issue: conversation
    "kind": "inline", "path": "…", "line": 42, "startLine": null, "side": "RIGHT",
    "diffHunk": "…", "body": "…", "inReplyToId": null,
    "originalCommitId": "…",   // commit the comment was written on
    "createdAt": "…", "url": "…" }] }
```

`line`/`startLine` are GitHub's `original_*` values, i.e. relative to `originalCommitId`.

## `truth/<pr#>/classified.json` — classify agent

Per comment: `category` (`actionable | question | nit | retraction | reply | praise`),
`severity` (`blocker | should | nit`), `needsOutsideContext`, `gist`.
- **Signal** (learned from, judged against): actionable, question, nit.
- **Concern** (counts for "caught first"): actionable or question with severity ≠ nit.

## `skill/<name>/rules/<id>.md`

```markdown
---
id: keep-company-in-oauth-state
title: "Keep companyId in the OAuth state round-trip"
kind: invariant                 # invariant | convention | taste
severity: blocker               # blocker | should | nit
paths:
  - "libs/backend/**/passport-auth/**"
sourceComments:
  - "gh:3396524691"
status: probation               # probation | active | retired
---

Plain prose: what to look for, why it matters, what fix to ask for.
```

Keys in this order; list items always quoted; no `# ` headings or bold metadata lines in the
body. `SKILL.md` is generated from the rules and must not be edited by hand.

Locations: `.watchtower/skill/<name>/` (working copy) → published to `.github/review-rules/<name>/`
in the target repo (read by CI) → optionally installed as a personal skill at
`~/.claude/skills/<name>/` (`watchtower skill install`).

## Learn agent output

```json
{ "operations": [{ "op": "create|update", "id": "…", "title": "…|null", "kind": "…|null",
                   "severity": "…|null", "paths": ["…"]|null, "body": "…|null",
                   "sourceComments": ["gh:…"] }],
  "skipped": [{ "commentId": "gh:…", "reason": "…" }] }
```

Creates start on `probation`. Updates append sources and may refine fields (null = keep).
Operations citing no comment from the current batch are rejected.

## Review agent output → `reviews/<pr#>/review.json`

Agent returns `findings[]` (`path`, `line`, `startLine|null`, `body`, `ruleIds`, `severity`,
`confidence`) and `summary` (`risk`, `overview`, `needsHumanJudgment[{area, why}]`).
Watchtower stores them as `comments[]` with `id: clone:<n>` and `placement: inline | summary`
(see gating in PLAN.md), plus `sha` and `rulesApplied`.

## Judge agent output

```json
{ "clone": [{ "cloneId": "clone:1", "verdict": "matches_dev|valid_unmentioned|noise",
              "devCommentId": "gh:…|null", "reasoning": "…" }],
  "dev":   [{ "devCommentId": "gh:…", "verdict": "caught|missed", "cloneId": "clone:1|null",
              "missedReason": "needs_context|learnable|new_concern|null", "reasoning": "…" }] }
```

## `ledger.json`, `stats/rules.json`, `candidates.json`

- ledger: `learned[commentId] = { pr, at, ruleIds }` — every comment fed to learn (incl. skipped).
- stats: `comments[githubCommentId] = { pr, ruleIds, reaction: up|down|null, postedAt }`; per-rule totals are recomputed from it.
- candidates: `{ prs: [...] }` — PRs where the dev commented after a pre-review.

## `runs/<ts>/report.json`

`{ schemaVersion: 2, startedAt, trainUntil, aggregate, prs: PrEval[] }` — see `src/score.ts`.
`report.md` renders the headline table, per-PR table, and spot-check samples.

## Inline comment marker

Every posted inline comment ends with `<!-- watchtower:rules=<id,id> run=<runId> -->`, which
`harvest` uses to attribute reactions to rules.
