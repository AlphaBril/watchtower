---
description: Run the review phase for a PR — generate clone comments using only policies and the diff
argument-hint: "<PR-number>"
---
Run the **review** phase for PR #$1.

Read all policies from `.watchtower/policies/`, then review the PR diff at `.watchtower/cache/prs/$1/diff.patch` using the metadata at `.watchtower/cache/prs/$1/meta.json`.

Write your clone comments to `.watchtower/reviews/$1/clone_comments.json`.

**CRITICAL: Do NOT read anything from `.watchtower/truth/`. You are simulating a fresh review using only policies and the diff.**

Follow your review agent instructions exactly. Be precise with line numbers, tag policies, and rate confidence honestly.
