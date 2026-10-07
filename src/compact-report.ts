import { acceptTooling, type Decision, type MergeApplied } from "./compact.js";
import type { AuditOutput, Rule, ToolingOutput } from "./schemas.js";

export interface CompactionRecord {
  rule: Rule;
  audit: AuditOutput | null;
  decision: Decision | null;
  /** Tooling-feasibility assessment; null when the rule wasn't a candidate (or it failed). */
  tooling: ToolingOutput | null;
  error: string | null;
}

const oneLine = (s: string, max = 240) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

const evidence = (a: AuditOutput) => `${a.conforming}/${a.checked} conform, ${a.violating} violate`;

function examples(a: AuditOutput, filter?: (conforms: boolean) => boolean, max = 3): string[] {
  return a.examples
    .filter((e) => !filter || filter(e.conforms))
    .slice(0, max)
    .map((e) => `  - \`${e.path}${e.line ? `:${e.line}` : ""}\` ${e.conforms ? "✓" : "✗"} ${oneLine(e.note, 160)}`);
}

export function renderCompactionReport(opts: {
  ref: string;
  sha: string;
  startedAt: string;
  before: number;
  merges: MergeApplied[];
  mergeRejected: number;
  records: CompactionRecord[];
  costUsd: number;
}): string {
  const { records } = opts;
  const by = (a: string) => records.filter((r) => r.decision?.action === a);
  const kept = by("keep");
  const rescoped = by("rescope");
  const retired = by("retire");
  const contested = by("contested");
  const failed = records.filter((r) => r.error);
  const live = records.length - retired.length;
  const toolingAssessed = records.filter((r) => r.tooling);
  const tooling = toolingAssessed.filter((r) => acceptTooling(r.tooling!));
  const bugs = records.filter(
    (r) => r.audit && r.rule.kind === "invariant" && r.rule.severity === "blocker" && r.audit.violating > 0 && r.decision?.action !== "retire",
  );
  const effortOrder = { low: 0, medium: 1, high: 2 } as const;
  const effortOf = (r: CompactionRecord) => effortOrder[r.tooling!.effort ?? "high"];
  const worstEffort = (recs: CompactionRecord[]) => (["low", "medium", "high"] as const)[Math.max(...recs.map(effortOf))];
  const groups = new Map<string, CompactionRecord[]>();
  for (const r of tooling) {
    const key = r.tooling!.mechanism!.trim();
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  // Cheapest groups first; within a group, cheapest rules first.
  const toolingGroups = [...groups.entries()]
    .map(([k, recs]) => [k, [...recs].sort((a, b) => effortOf(a) - effortOf(b))] as const)
    .sort(([, a], [, b]) => Math.max(...a.map(effortOf)) - Math.max(...b.map(effortOf)) || b.length - a.length);

  return [
    "# Watchtower rule compaction",
    "",
    `Audited against \`${opts.ref}\` @ \`${opts.sha.slice(0, 12)}\` · started ${opts.startedAt} · model spend ≈ $${opts.costUsd}.`,
    "",
    "## Summary",
    "",
    "| | Rules |",
    "|---|---|",
    `| Before | ${opts.before} |`,
    `| Merged away (duplicates) | ${opts.merges.reduce((n, m) => n + m.from.length - 1, 0)} — into ${opts.merges.length} merged rule(s)${opts.mergeRejected ? `, ${opts.mergeRejected} merge(s) rejected` : ""} |`,
    `| Kept | ${kept.length} |`,
    `| Rescoped (paths narrowed/fixed) | ${rescoped.length} |`,
    `| Retired by the audit | ${retired.length} |`,
    `| Contested (audit says drop, but ≥5 review comments back it) | ${contested.length} |`,
    `| Audit failed (kept unchanged) | ${failed.length} |`,
    `| **Live after compaction** | **${live}** |`,
    `| Could be enforced by tooling instead | ${tooling.length} of ${toolingAssessed.length} assessed, in ${toolingGroups.length} change(s) |`,
    "",
    "Nothing was deleted: retired rules keep their file with `status: retired`, and the full",
    "pre-compaction rule set is backed up next to this report (`skill-before/`).",
    "",
    ...(contested.length
      ? [
          "## Contested — your call",
          "",
          "The audit recommends dropping these, but the developer raised them repeatedly. Retire by",
          "setting `status: retired` in the rule file, or keep as is.",
          "",
          ...contested.flatMap((r) => [
            `- **${r.rule.id}** (${r.rule.sourceComments.length} comments, ${r.rule.severity}) — ${oneLine(r.decision!.reason)}`,
            `  - evidence: ${evidence(r.audit!)}`,
            ...examples(r.audit!),
          ]),
          "",
        ]
      : []),
    ...(bugs.length
      ? [
          "## Possible live bugs",
          "",
          "Blocker invariants the audit found violated on the current code. Worth a look:",
          "",
          ...bugs.flatMap((r) => [`- **${r.rule.id}** — ${r.rule.title} (${evidence(r.audit!)})`, ...examples(r.audit!, (c) => !c)]),
          "",
        ]
      : []),
    ...(tooling.length
      ? [
          "## Tooling recommendations",
          "",
          `Rules a machine could enforce instead of a reviewer (${toolingAssessed.length} assessed, ${tooling.length} accepted with`,
          "zero false positives on the audit's examples), grouped by mechanism — each group is one change.",
          "Until a recommendation is implemented the rule stays in the pre-review; once it is, retire the rule.",
          "",
          ...toolingGroups.flatMap(([mechanism, recs]) => [
            `### ${mechanism} — ${recs.length} rule(s) · effort ${worstEffort(recs)}`,
            "",
            ...recs.flatMap((r) => {
              const t = r.tooling!;
              return [
                `#### ${r.rule.id} — ${t.kind ?? "other"} · effort ${t.effort ?? "?"} · catches ${t.catchesViolations}/${r.audit!.examples.filter((e) => !e.conforms).length} sampled violation(s)`,
                "",
                `${r.rule.title}. ${t.summary ?? ""}`.trim(),
                "",
                ...(t.implementation ? ["```", t.implementation.trim(), "```", ""] : []),
              ];
            }),
          ]),
        ]
      : []),
    "## Merged",
    "",
    ...(opts.merges.length ? opts.merges.map((m) => `- **${m.id}** ← ${m.from.filter((f) => f !== m.id).join(", ")}`) : ["(none)"]),
    "",
    "## Retired",
    "",
    ...(retired.length
      ? retired.flatMap((r) => [
          `- **${r.rule.id}** (${r.rule.sourceComments.length} comment(s)) — ${oneLine(r.decision!.reason)}${r.audit ? ` · ${evidence(r.audit)}` : ""}`,
        ])
      : ["(none)"]),
    "",
    "## Rescoped",
    "",
    ...(rescoped.length
      ? rescoped.map((r) => `- **${r.rule.id}**: ${r.rule.paths.join(", ") || "all files"} → ${r.decision!.newPaths!.join(", ")}`)
      : ["(none)"]),
    "",
    ...(failed.length
      ? ["## Audit failures", "", ...failed.map((r) => `- **${r.rule.id}**: ${oneLine(r.error!)}`), ""]
      : []),
  ].join("\n");
}
