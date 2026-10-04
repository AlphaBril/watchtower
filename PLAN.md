# Watchtower — Plan & Progress Tracker (v2)

> A **first reviewer** that works ahead of one developer. It learns the concerns that developer
> reliably raises from their past reviews, pre-reviews new PRs so those concerns are raised
> before the developer looks, and points them at the calls that need their judgment.
> The developer stays the approver.

**Success is measured by usefulness, not mimicry:**
- **Caught first** — share of the developer's real concerns the clone raised (held-out replay).
- **Inline usefulness** — share of inline clone comments that matched the developer or were valid on their own; in production, the developer's 👍/👎.
- **Noise** — wrong/trivial comments per PR, and especially on PRs the developer passed clean.

---

## Decisions (locked)

| Topic | Decision |
|---|---|
| Runtime | TypeScript CLI; agents run through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) |
| Agent contract | Agents **never write files**: each returns `structured_output` (JSON Schema from zod); watchtower validates and writes |
| Isolation | Review agent's cwd is a **git worktree at the reviewed commit** in a temp dir; tools `Read/Grep/Glob` only; PreToolUse hook denies paths outside it; `settingSources: []` |
| Rules | Skill-shaped folder (`SKILL.md` index + `rules/<id>.md`, with `kind`, `severity`, `paths`, `status`). Published to the target repo at `.github/review-rules/<dev>-review/` (outside `.claude/`, so teammates' sessions never load it); the developer installs it as a **personal** skill with `watchtower skill install` |
| Evaluation | Temporal **train/test split** (`trainUntil`); learn only from train, `evaluate` replays test; leak check against the ledger |
| Replay fidelity | Diff at the **commit the developer reviewed** (`base…reviewedSha`), comment lines from `original_line` |
| Comment hygiene | `classify` agent tags every dev comment (actionable/question/nit/retraction/reply/praise, severity, needs-outside-context) |
| Delivery | GitHub Action in the target repo runs `watchtower review --post`; one non-blocking `COMMENT` review; rules read from the **base** branch |
| Feedback | Developer 👍/👎 on inline comments → `harvest` → per-rule stats → `publish` promotes/retires via a rules PR the developer approves |
| Secrets | `GITHUB_TOKEN` + `ANTHROPIC_API_KEY` from env, never on disk |

## Commands

| Command | What it does |
|---|---|
| `setup` | `--dev --repo --repo-path --train-until [--skill-name --rules-path --post-threshold --max-budget]` |
| `ingest [prs…]` | Discover PRs the dev reviewed (incl. clean approvals); cache meta + diff at reviewed commit + all dev comments |
| `learn [prs…]` | classify → learn on training PRs + harvested candidates; ledger prevents re-feeding |
| `evaluate` | Held-out replay: review in sandbox → judge → `runs/<ts>/report.{md,json}` (the comfort report) |
| `review <pr> [--post]` | Pre-review a live PR at head; dry-run prints, `--post` publishes. CI: `--in-place --rules-ref origin/<base>` |
| `harvest` | 👍/👎 on watchtower comments → `stats/rules.json`; PRs where the dev commented after the pre-review → candidates |
| `publish` | Apply promotions/retirements; open a PR updating `.github/review-rules/<dev>-review/` in the target repo; re-syncs the personal skill |
| `skill install\|uninstall\|status` | Personal copy at `~/.claude/skills/<dev>-review/`, kept in sync by `learn`/`publish` |
| `rules` | List rules with feedback stats |

## Filesystem (`.watchtower/`, gitignored)

```
config.json                       # dev, repo, localRepoPath, trainUntil, models, thresholds
cache/prs/<pr#>/meta.json         # incl. reviewedSha, reviewedAt, devReviewStates, diffSource
cache/prs/<pr#>/diff.patch        # base…reviewedSha
truth/<pr#>/review_comments.json  # dev comments (inline / review body / conversation)
truth/<pr#>/classified.json       # classify output
skill/<name>/SKILL.md             # generated index
skill/<name>/rules/<id>.md        # rules (watchtower-written, validated)
ledger.json                       # dev comment ids already learned from
stats/rules.json                  # per posted comment: rules + dev reaction
candidates.json                   # harvested PRs to learn from
reviews/<pr#>/review.json         # last `review` output
runs/<ts>/{report.md,report.json,costs.json,reviews/}
```

## Gating (what gets posted inline)

- confidence < 0.5 → dropped
- not on a commentable HEAD line → review-body note
- cites an `active` rule, or confidence ≥ `postThreshold` (0.85) → inline
- otherwise → review-body note ("lower-confidence notes")

Rule lifecycle: new rules start `probation`. ≥3 rated and ≥70% 👍 → `active`. ≥3 rated and <50% 👍 → `retired`. Changes only land through `publish`'s PR.

## Phases

- [x] 1. Runtime swap — Agent SDK wrapper with structured output, prompts ported, pi removed
- [x] 2. Data correctness — reviewed-commit diff, classify, clean PRs, ledger, train/test split
- [x] 3. Rules as a skill — new frontmatter, SKILL.md index, path-scoped selection
- [x] 4. `evaluate` comfort report
- [x] 5. `review --post` with gating + triage summary; Action template (`templates/watchtower-review.yml`)
- [x] 6. `harvest` + `publish`
- [ ] **Live validation** (needs real runs — see below)
- [ ] Harvest state in CI (today `harvest`/`learn`/`publish` run locally, state lives in `.watchtower/`)
- [ ] Migrate PR discovery from deprecated REST search to GraphQL

### Live validation checklist
1. `npm install && npm test`
2. `watchtower setup --repo-path ~/Documents/virtual-brain --train-until <date ~2/3 through history>`
3. `watchtower ingest --limit 60` → check train/test counts and that few PRs fall back to `FINAL diff`
4. `watchtower learn` → read the rules in `.watchtower/skill/*/rules/` — would the dev sign off on them?
5. `watchtower evaluate` → read `runs/<ts>/report.md`, spot-check the "valid but unmentioned" and "noise" samples
6. `watchtower review <recent pr>` (dry run) → then pilot the Action on the target repo

## Risks / open questions
- "Valid but unmentioned" is LLM-judged — the report lists samples so the developer can confirm them.
- Rules learned from a small history will cover few files; `review` says so ("outside the learned areas") rather than guessing.
- Fork PRs get no secrets on `pull_request` and are skipped by the template.
- Cost: classify (Haiku) is cheap; learn/judge (Opus) and review (Sonnet, with tool use) dominate — see `runs/<ts>/costs.json`.
