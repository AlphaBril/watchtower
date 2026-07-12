---
description: Run the learn phase for a PR — distill developer review comments into policies
argument-hint: "<PR-number>"
---
Run the **learn** phase for PR #$1.

Read the developer's real review comments from `.watchtower/truth/$1/review_comments.json`, study the PR context from `.watchtower/cache/prs/$1/`, and create or update policy files in `.watchtower/policies/`.

Follow your learn agent instructions exactly. Process every comment, create/update policies, and report the summary.
