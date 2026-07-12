# Watchtower — Plan & Progress Tracker

> A CLI that builds a "digital clone" of a specific developer's **PR-review style**.
> It mines the developer's past review comments, lets the `pi` agent turn them into
> policies, then validates those policies by having `pi` re-review the same PRs with a
> fresh context and checking whether it reproduces similar comments. Self-improves per
> PR; flags low-confidence PRs for the real developer.

---

## Decisions (locked)

| Topic | Decision |
|---|---|
| Language/runtime | TypeScript / Node |
| LLM backend | External `pi` coding agent, invoked over CLI (watchtower never calls a model API directly) |
| pi interface | pi coding agent (`@earendil-works/pi-coding-agent`) configured under `.pi/`; **filesystem is the contract**; agents driven by PR number |
| pi agents (exist) | `learn`, `review`, `judge` under `.pi/agents/watchtower/` + slash prompts `.pi/prompts/*.md` (arg `$1` = PR#); team in `.pi/agents/teams.yaml` |
| No fake pi | Do not stub pi; drive the real agents |
| GitHub auth (POC) | Personal Access Token |
| Repo scope | One specific repo, chosen at setup |
| POC learning path | Review-comment cloning first (authored-PR coding-style comes later) |
| Match metric (POC) | **Deterministic first** (file+line bucketing + keyword overlap); escalate ambiguous/unmatched pairs to the `judge` agent (already built) |
| Storage | Flat files — policies as `.md`, cache/scores as JSON |
| Hiding real comments from `review` | **Enforced in code** — `.pi/extensions/isolation-guard.ts` blocks `read/grep/find/ls` into `truth/` + `runs/` while marker `.watchtower/.review-active` exists |
| CLI tooling | `commander` (args) + `tsx` (dev, no build step); `execa` (pi subprocess); `zod` (validate pi JSON outputs) |
| Secrets | PAT from `GITHUB_TOKEN` env var (never on disk); non-secret config in `.watchtower/config.json` |

## Division of labor

| Concern | Owner |
|---|---|
| GitHub auth + fetch PRs/reviews/diffs | watchtower |
| Write PR data into the cache + `truth/` | watchtower |
| Toggle `.watchtower/.review-active` marker around review runs | watchtower |
| `learn <pr#>` → read cached review + policies, write/update policy `.md` | pi agent |
| `review <pr#>` → read cached PR + policies, write clone comments | pi agent |
| Deterministic match clone ↔ real comments | watchtower |
| Build `judge/pending/<pr#>/pairs.json` for ambiguous/unmatched pairs | watchtower |
| `judge <pr#>` → semantic verdicts + recovered matches | pi agent |
| Fold judgments into final score, decide loop/flag | watchtower |

## Filesystem contract

```
.watchtower/
  config.json                         # PAT ref, target dev, owner/repo, pi command, thresholds
  .review-active                      # marker: present ONLY while `pi review` runs (blocks truth/ access)
  cache/
    prs/<pr#>/
      meta.json                       # title, author, base/head SHA, changed files
      diff.patch                      # full PR diff
  truth/                              # REAL dev comments — review agent is NEVER pointed here
    <pr#>/review_comments.json        # input to `learn`; input to watchtower scoring
  policies/
    <slug>.md                         # learn writes; review reads
  reviews/
    <pr#>/clone_comments.json         # review writes; watchtower reads to score
  judge/
    pending/<pr#>/pairs.json          # watchtower writes ambiguous/unmatched pairs
    results/<pr#>/judgments.json      # judge writes semantic verdicts + recovered matches
  runs/<timestamp>/report.json        # scores, mismatches, decision
```

Structural isolation (enforced by `.pi/extensions/isolation-guard.ts`): while the
`.watchtower/.review-active` marker exists, the review agent's `read/grep/find/ls`
into `truth/` and `runs/` is hard-blocked. Watchtower **must** create the marker
before spawning `pi review` and remove it afterward (even on error).

## Loop

```
watchtower: fetch PR N → cache/prs/N/{meta,diff} + truth/N/review_comments.json
        │
pi learn N        → writes/updates policies/*.md   (from truth/N)
        │
watchtower: touch .watchtower/.review-active        (arm isolation guard)
pi review N       → writes reviews/N/clone_comments.json   (sees diff + policies ONLY)
watchtower: rm .watchtower/.review-active            (disarm — always, even on error)
        │
watchtower: deterministic match clone_comments ↔ truth comments (file+line bucket + keyword)
        │  ├─ confident matches → keep
        │  └─ ambiguous pairs + unmatched (both sides) → judge/pending/N/pairs.json
        │
pi judge N        → judge/results/N/judgments.json   (semantic verdicts + recovered matches)
        │
watchtower: fold deterministic + judge results → final precision/recall/FP score
        ├─ score high  ► validated, next PR
        └─ score low   ► iterate; if stuck after N tries ► flag dev
```

## CLI surface (watchtower)

- `watchtower setup` — persist PAT, target dev, owner/repo, `pi` command/invocation, thresholds.
- `watchtower learn` — ingest dev's reviewed PRs; per PR run learn → (marker) review (marker) → deterministic match → judge → score → loop/flag; print scorecard.
- `watchtower review <pr#>` — ingest one PR, run the review agent, dry-run/post comments, flag if low confidence.
- `watchtower policies` — list/diff the policy set.

**Invoking pi (confirmed):**

```
pi -p -e .pi/extensions/isolation-guard.ts "/learn 10"
```

- `-p` — non-interactive/print mode; the agent's result comes back on stdout (watchtower captures it).
- `-e .pi/extensions/isolation-guard.ts` — load the isolation guard extension. **Pass this on EVERY call** (learn/review/judge), not just review — the guard is inert unless the `.watchtower/.review-active` marker is present, so it's safe on learn/judge and mandatory on review.
- `"/learn 10"` — the slash-prompt (`.pi/prompts/<name>.md`) plus PR number as `$1`. Swap `/learn`→`/review`→`/judge`.

So watchtower's three invocations are:
- `pi -p -e .pi/extensions/isolation-guard.ts "/learn <pr#>"`
- (touch marker) `pi -p -e .pi/extensions/isolation-guard.ts "/review <pr#>"` (rm marker)
- `pi -p -e .pi/extensions/isolation-guard.ts "/judge <pr#>"`

Agents fail cleanly when inputs are missing (verified: a bare `/learn 10` with no `.watchtower/` reports exactly which files are absent), so watchtower must guarantee cache/truth exist before invoking.

---

## Phases & task status

Legend: [ ] todo · [~] in progress · [x] done

### Phase 0 — Scaffold ✅ COMPLETE
- [x] TS/Node project init (package.json, tsconfig — ESM, strict; deps: commander, execa, zod, @octokit/rest)
- [x] CLI framework wired (`setup`/`learn`/`review`/`policies` stubs) — `src/cli.ts` + `src/commands/*`
- [x] Config module (zod-validated read/write `.watchtower/config.json`; PAT from `GITHUB_TOKEN`) — `src/config.ts`
- [x] Folder-convention helper (paths for cache/truth/policies/reviews/judge/runs) — `src/paths.ts`
- [x] Exact pi CLI invocation confirmed: `pi -p -e .pi/extensions/isolation-guard.ts "/<agent> <pr#>"`
- [x] `pi` process runner (execa; review auto-wrapped in marker; surfaces non-zero exit) — `src/pi.ts`
- [x] Marker helper: `withReviewMarker` try/finally + `clearStaleMarker` on startup — `src/marker.ts`
- [x] Verified: typecheck clean; `--help`, `setup`, `policies`, `learn`, missing-PAT error all work

### Phase 1 — GitHub ingestion ✅ COMPLETE
- [x] Octokit client with PAT (`src/github.ts`); zod file schemas (`src/schemas.ts`)
- [x] Fetch PRs the target dev reviewed in the repo (`search reviewed-by:`)
- [x] Fetch PR meta + full diff → `cache/prs/<pr#>/` (diff via `.diff` media type)
- [x] Fetch dev's review comments with file/line/hunk anchoring → `truth/<pr#>/review_comments.json` (`src/ingest.ts`)
- [x] `learn` prints mined summary; `review <pr#>` ingests one PR; idempotent w/ `--force`
- [x] Verified live against a real private repo (getvirtualbrain/virtual-brain PR #3055 — 5 comments, anchoring correct)

**Findings from live data (feed into later phases):**
- `search.issuesAndPullRequests` REST endpoint is deprecated — migrate to GraphQL search before the App version.
- Comments can have empty `diffHunk` and/or `line: null` (outdated/file-level comments) — matcher (Phase 3) must tolerate null line anchors.
- Some review comments are meta/retraction ("my bad", "finalement on ne fera pas ça") — NOT policy signal. Confirms the need for nit/retraction filtering before/at learn.
- Comments are in French — pi agents must be language-agnostic (they are; just noting).

### Phase 2 — pi agent wiring
- [ ] Invoke `learn <pr#>`; verify it reads `truth/` + writes/merges `policies/*.md`
- [ ] Arm marker → invoke `review <pr#>` → disarm marker; verify it writes `reviews/<pr#>/clone_comments.json`
- [ ] Verify isolation guard actually blocks `truth/` access during review (deliberately probe)
- [ ] Parse the agents' JSON outputs against SCHEMAS.md; fail loudly on schema drift

### Phase 3 — Matching, scoring, loop (heart of POC)
- [ ] Deterministic matcher (bucket by file+line region, keyword/overlap scoring)
- [ ] Split results: confident matches vs. ambiguous pairs vs. unmatched (both sides)
- [ ] Write `judge/pending/<pr#>/pairs.json`; invoke `judge <pr#>`; read `judge/results/<pr#>/judgments.json`
- [ ] Fold deterministic + judge verdicts → precision/recall + false-positive rate
- [ ] Per-PR scorecard + `runs/<ts>/report.json`
- [ ] Refine-on-mismatch loop with iteration cap

### Phase 4 — Flagging & self-improvement
- [ ] Confidence thresholds → validated / iterate / flag
- [ ] Flag-for-human mechanism (ping the dev)
- [ ] Re-learn from a new human review

### Phase 5 — Post-POC
- [ ] Coding-style-from-authored-PRs (new pi agent + authored-PR ingestion)
- [ ] Tune judge escalation policy (which pairs are "ambiguous" enough to send)
- [ ] PAT → GitHub App + webhooks (autonomous pipeline)

---

## Open questions / risks
- Comment↔diff/line anchoring across a PR is fiddly (GitHub `diff_hunk` + position). Must be right in Phase 1.
- **Marker leak:** if watchtower crashes mid-review and leaves `.review-active` behind, later non-review reads get blocked. Cleanup must be in a `finally`, and `setup`/startup should clear a stale marker.
- Judge sees `truth/` + `reviews/` (needed for recovery) — fine because judge runs *after* review, with the marker down. Ordering matters: never run judge while the review marker is up.
- "Nit vs. substantive" comment classification — the learn agent skips threaded replies, but may still need explicit nit-tagging so policies aren't polluted.
- Overfitting: validating on the same PRs we learned from inflates scores. Add a held-out test set once enough data exists.

## Schemas
See [SCHEMAS.md](./SCHEMAS.md) for the file contracts. Note the pi agents already
emit their own schemas — reconcile SCHEMAS.md against the agent prompts, and add the
judge `pairs.json` / `judgments.json` shapes there.
