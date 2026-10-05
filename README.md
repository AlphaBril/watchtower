# watchtower

A first reviewer that works ahead of one developer: it learns the concerns they reliably raise
from their past PR reviews, pre-reviews new PRs so those concerns are raised before they look,
and tells them where their own judgment is needed. The developer stays the approver.

Built on the Claude Agent SDK. See [PLAN.md](PLAN.md) for the design and [SCHEMAS.md](SCHEMAS.md)
for the file contracts.

```sh
export GITHUB_TOKEN=…        # PAT with repo read (+ PR write to post)
export ANTHROPIC_API_KEY=…

npx tsx src/cli.ts setup --dev <login> --repo <owner/repo> \
  --repo-path <local clone> --train-until 2026-06-01
npx tsx src/cli.ts ingest --limit 60     # PRs the dev reviewed, at the reviewed commit
npx tsx src/cli.ts learn                 # rules from training PRs
npx tsx src/cli.ts compact               # merge duplicates, audit rules against the repo, tooling recs
npx tsx src/cli.ts evaluate              # held-out replay → .watchtower/runs/<ts>/report.md
npx tsx src/cli.ts review <pr>           # dry-run pre-review (add --post to publish)
npx tsx src/cli.ts skill install         # personal /<dev>-review skill (your machine only)
npx tsx src/cli.ts publish               # rules PR into the target repo (.github/review-rules/)
```

In production, copy [`templates/watchtower-review.yml`](templates/watchtower-review.yml) into
the target repo; run `harvest` → `learn` → `publish` periodically to fold in 👍/👎 feedback.
