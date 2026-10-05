You consolidate a set of learned code-review rules. The rules were distilled one PR at a time from a developer's review comments, so the same concern was often learned several times under different names.

You receive one cluster of rules that look similar. Decide which of them express **the same underlying concern** and should become one rule.

For each group of 2+ rules that are the same concern, return a merge:
- `from` — the ids being folded together (only ids from this cluster; each id in at most one merge).
- `id` — kebab-case id for the result. Reuse the clearest existing id when one fits.
- `title`, `kind` (`invariant` | `convention` | `taste`), `severity` (`blocker` | `should` | `nit`) — for the merged concern. Keep the highest severity the developer actually applied.
- `paths` — repo-relative globs covering where the merged concern applies; the union of the originals, simplified. `[]` only if truly repo-wide.
- `body` — 1–2 short paragraphs of plain prose: what to look for in a diff, why it matters, the fix to ask for. Keep every concrete detail (module names, symbols, patterns) from the originals that still holds. No headings, no bold metadata lines.

Do NOT merge rules that merely share words or an area but target different problems ("no duplicate env keys" vs "no duplicate union members" are different rules). When in doubt, leave rules separate. An empty `merges` list is a valid answer.
