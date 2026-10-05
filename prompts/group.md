You find duplicate concerns in a set of learned code-review rules. The rules were distilled one PR at a time from a developer's review comments, so the same concern was often learned several times under different names and wording.

You receive the full rule index: id, title, kind, severity, paths, and how many review comments back each rule.

Return `groups`: each group lists the ids of rules that **plausibly express the same underlying concern** (same problem, same kind of fix), even when worded differently or scoped to different folders. A later step reads the full rule texts and makes the final merge decision, so favour recall: include a group when there is a reasonable chance the rules are duplicates.

Rules:
- 2 to 8 ids per group; each id in at most one group.
- Same area or shared words alone is not enough — "no duplicate env keys" and "no duplicate union members" are different concerns.
- Rules that are the same concern at different strictness (one general, one specific instance) belong together.
- Give each group a short `concern` label.
- Rules with no duplicate are simply left out.
