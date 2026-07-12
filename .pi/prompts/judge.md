---
description: Run the judge phase for a PR — semantically evaluate candidate comment pairs and recover missed matches
argument-hint: "<PR-number>"
---
Run the **judge** phase for PR #$1.

Read the candidate pairs from `.watchtower/judge/pending/$1/pairs.json`. Use the diff at `.watchtower/cache/prs/$1/diff.patch` for code context.

For each pair, evaluate whether the clone comment and the real developer comment express the same concern. Also cross-check any unmatched comments for recovered semantic matches.

Write your judgments to `.watchtower/judge/results/$1/judgments.json`.

Follow your judge agent instructions exactly. Be rigorous — don't over-match or under-match. Include reasoning for every verdict.
