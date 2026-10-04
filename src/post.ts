import type { ReviewFile } from "./schemas.js";
import type { InlineDraft } from "./github.js";

/**
 * Renders a review for GitHub. Every inline comment carries a hidden marker
 * so `harvest` can attribute the dev's 👍/👎 back to the rules behind it.
 */

const MARKER_RE = /<!-- watchtower:rules=([a-z0-9,-]*) run=([A-Za-z0-9-]+) -->/;

export function marker(ruleIds: string[], runId: string): string {
  return `<!-- watchtower:rules=${ruleIds.join(",")} run=${runId} -->`;
}

export function parseMarker(body: string): { ruleIds: string[]; runId: string } | null {
  const m = body.match(MARKER_RE);
  if (!m) return null;
  return { ruleIds: m[1] ? m[1].split(",").filter(Boolean) : [], runId: m[2]! };
}

export function renderInline(review: ReviewFile, runId: string): InlineDraft[] {
  return review.comments
    .filter((c) => c.placement === "inline")
    .map((c) => ({
      path: c.path,
      line: c.line,
      startLine: c.startLine,
      body: [
        c.body.trim(),
        "",
        `<sub>watchtower · ${c.severity} · ${c.ruleIds.length ? c.ruleIds.join(", ") : "possible defect"} · react 👍 / 👎 to train it</sub>`,
        marker(c.ruleIds, runId),
      ].join("\n"),
    }));
}

export function renderReviewBody(review: ReviewFile, dev: string, runId: string): string {
  const { summary } = review;
  const notes = review.comments.filter((c) => c.placement === "summary");
  const inlineCount = review.comments.length - notes.length;
  const lines = [
    `**Watchtower pre-review** for @${dev} · risk: **${summary.risk}** · ${inlineCount} inline comment${inlineCount === 1 ? "" : "s"}`,
    "",
    summary.overview.trim(),
  ];
  if (summary.needsHumanJudgment.length > 0) {
    lines.push("", "**Needs your judgment**", ...summary.needsHumanJudgment.map((h) => `- **${h.area}** — ${h.why}`));
  }
  if (notes.length > 0) {
    lines.push(
      "",
      `<details><summary>Lower-confidence notes (${notes.length})</summary>`,
      "",
      ...notes.map(
        (n) =>
          `- \`${n.path}:${n.line}\` — ${n.body.replace(/\s+/g, " ").trim()} _(${n.ruleIds.join(", ") || "no rule"}, confidence ${n.confidence})_`,
      ),
      "",
      "</details>",
    );
  }
  lines.push(
    "",
    `<sub>Rules checked: ${review.rulesApplied.length ? review.rulesApplied.join(", ") : "none"}. This is a first pass to save review time — the human review still decides.</sub>`,
    `<!-- watchtower:run=${runId} -->`,
  );
  return lines.join("\n");
}
