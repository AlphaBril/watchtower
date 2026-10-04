import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { matchesAny } from "./glob.js";
import {
  RULE_ID_RE,
  RuleSchema,
  SOURCE_COMMENT_RE,
  type LearnOperation,
  type Rule,
} from "./schemas.js";

/**
 * Rules are the learned review concerns, stored as a Claude Code skill:
 *
 *   <skillDir>/SKILL.md        — generated index (name/description frontmatter
 *                                + a table of live rules)
 *   <skillDir>/rules/<id>.md   — one rule: strict frontmatter + prose body
 *
 * Only watchtower writes these files (agents return structured operations),
 * so format validation happens here, at write time.
 *
 * Frontmatter is a small YAML subset — flat scalars plus block lists — parsed
 * without a YAML dependency. List items are always double-quoted on write so
 * globs like `**` stay valid YAML for any other reader.
 */

const KEY_ORDER = ["id", "title", "kind", "severity", "paths", "sourceComments", "status"] as const;
const LIST_KEYS = new Set(["paths", "sourceComments"]);

const FORBIDDEN_BODY: Array<{ re: RegExp; label: string }> = [
  { re: /^#\s/m, label: "a top-level `# ` heading" },
  { re: /^\*\*(Source|Reviewer|Date|Confidence|Version):\*\*/m, label: "bold-labelled metadata lines" },
];

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

export function parseRule(contents: string, fileStem?: string): Rule {
  const m = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("rule file has no `---` frontmatter");
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let listKey: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      lists[listKey]!.push(unquote(item[1]!));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) throw new Error(`unrecognized frontmatter line: ${JSON.stringify(line)}`);
    const [, key, raw] = kv as unknown as [string, string, string];
    if (raw.trim() === "" || raw.trim() === "[]") {
      lists[key] = [];
      listKey = raw.trim() === "" ? key : null;
    } else {
      scalars[key] = unquote(raw);
      listKey = null;
    }
  }
  const rule = RuleSchema.parse({
    id: scalars.id,
    title: scalars.title,
    kind: scalars.kind,
    severity: scalars.severity,
    paths: lists.paths ?? [],
    sourceComments: lists.sourceComments,
    status: scalars.status,
    body: m[2]!.trim(),
  });
  if (fileStem !== undefined && rule.id !== fileStem) {
    throw new Error(`rule id ${JSON.stringify(rule.id)} must equal filename stem ${JSON.stringify(fileStem)}`);
  }
  return rule;
}

export function serializeRule(rule: Rule): string {
  const lines = ["---"];
  for (const key of KEY_ORDER) {
    if (LIST_KEYS.has(key)) {
      const items = rule[key] as string[];
      if (items.length === 0) lines.push(`${key}: []`);
      else lines.push(`${key}:`, ...items.map((i) => `  - ${quote(i)}`));
    } else {
      lines.push(`${key}: ${key === "title" ? quote(rule[key]) : rule[key]}`);
    }
  }
  lines.push("---", "", rule.body.trim(), "");
  return lines.join("\n");
}

/** Throws with every problem found; returns the rule unchanged when valid. */
export function validateRule(rule: Rule): Rule {
  const errors: string[] = [];
  const parsed = RuleSchema.safeParse(rule);
  if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  for (const { re, label } of FORBIDDEN_BODY) {
    if (re.test(rule.body)) errors.push(`body contains ${label}; use plain prose`);
  }
  if (errors.length > 0) throw new Error(`invalid rule ${rule.id}:\n  - ${errors.join("\n  - ")}`);
  return rule;
}

export async function readRules(skillDir: string): Promise<Rule[]> {
  const dir = join(skillDir, "rules");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const rules: Rule[] = [];
  for (const f of files.filter((f) => f.endsWith(".md")).sort()) {
    const stem = basename(f, extname(f));
    try {
      rules.push(parseRule(await readFile(join(dir, f), "utf8"), stem));
    } catch (e) {
      throw new Error(`${join(dir, f)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return rules;
}

export async function writeRule(skillDir: string, rule: Rule): Promise<void> {
  validateRule(rule);
  const dir = join(skillDir, "rules");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${rule.id}.md`), serializeRule(rule), "utf8");
}

/** Live rules that apply to at least one of the changed paths. */
export function applicableRules(rules: Rule[], changed: string[]): Rule[] {
  return rules.filter(
    (r) => r.status !== "retired" && changed.some((p) => matchesAny(p, r.paths)),
  );
}

// ── learn operations ─────────────────────────────────────────────────────────

export interface ApplyResult {
  created: string[];
  updated: string[];
  rejected: Array<{ id: string; reason: string }>;
  /** dev comment id → rule ids it was folded into */
  bySource: Map<string, string[]>;
}

/**
 * Applies the learn agent's operations to the rule set. New rules start on
 * probation. Updates append sources and may refine prose/paths but never
 * touch id or status. Invalid operations are rejected, not fatal.
 */
export function applyLearnOps(
  rules: Rule[],
  ops: LearnOperation[],
  allowedSources: Set<string>,
): { rules: Rule[]; result: ApplyResult } {
  const byId = new Map(rules.map((r) => [r.id, { ...r }]));
  const result: ApplyResult = { created: [], updated: [], rejected: [], bySource: new Map() };
  const touched = new Set<string>();

  for (const op of ops) {
    const sources = op.sourceComments.filter((s) => SOURCE_COMMENT_RE.test(s) && allowedSources.has(s));
    if (sources.length === 0) {
      result.rejected.push({ id: op.id, reason: "no valid sourceComments from this batch" });
      continue;
    }
    try {
      if (op.op === "create") {
        if (!RULE_ID_RE.test(op.id)) throw new Error("id must be kebab-case");
        if (byId.has(op.id)) throw new Error("id already exists (use update)");
        if (!op.title || !op.kind || !op.severity || !op.body) {
          throw new Error("create needs title, kind, severity and body");
        }
        const rule = validateRule({
          id: op.id,
          title: op.title,
          kind: op.kind,
          severity: op.severity,
          paths: op.paths ?? [],
          sourceComments: sources,
          status: "probation",
          body: op.body,
        });
        byId.set(rule.id, rule);
        result.created.push(rule.id);
      } else {
        const current = byId.get(op.id);
        if (!current) throw new Error("unknown rule id");
        const next = validateRule({
          ...current,
          title: op.title ?? current.title,
          kind: op.kind ?? current.kind,
          severity: op.severity ?? current.severity,
          paths: op.paths ?? current.paths,
          body: op.body ?? current.body,
          sourceComments: [...new Set([...current.sourceComments, ...sources])],
        });
        byId.set(next.id, next);
        if (!result.created.includes(next.id)) result.updated.push(next.id);
      }
      touched.add(op.id);
      for (const s of sources) result.bySource.set(s, [...(result.bySource.get(s) ?? []), op.id]);
    } catch (e) {
      result.rejected.push({ id: op.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  result.updated = [...new Set(result.updated)];
  return { rules: [...byId.values()], result };
}

// ── SKILL.md ─────────────────────────────────────────────────────────────────

export function renderSkillMd(opts: {
  name: string;
  dev: string;
  repo: string;
  rules: Rule[];
}): string {
  const live = opts.rules
    .filter((r) => r.status !== "retired")
    .sort((a, b) => a.id.localeCompare(b.id));
  const rows = live.map(
    (r) =>
      `| [${r.id}](rules/${r.id}.md) | ${r.title.replace(/\|/g, "\\|")} | ${r.severity} | ${r.status} | ${r.paths.length ? r.paths.map((p) => `\`${p}\``).join(", ") : "all files"} |`,
  );
  return [
    "---",
    `name: ${opts.name}`,
    `description: Recurring review concerns and codebase invariants that ${opts.dev} raises on ${opts.repo} pull requests. Use when reviewing a PR, a diff, or a change in this repository, to check it the way ${opts.dev} would before they review it.`,
    "---",
    "",
    `# Review concerns learned from ${opts.dev}`,
    "",
    "Each rule below was learned from real review comments and is kept or retired based on",
    `${opts.dev}'s 👍/👎 on the comments it produced. Read only the rules whose paths match`,
    "the files you are reviewing, then apply them to the changed lines.",
    "",
    "- `active` rules have a track record; `probation` rules are new — raise them softly.",
    "- Comment only where a rule clearly applies. Do not restate the rule; explain the concrete problem and the fix.",
    "- Flag product/design decisions you cannot settle from the code for the human reviewer instead of guessing.",
    "",
    "| Rule | Concern | Severity | Status | Applies to |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "<!-- generated by watchtower; edit rules/*.md, not this table -->",
    "",
  ].join("\n");
}

export async function writeSkillIndex(
  skillDir: string,
  opts: { name: string; dev: string; repo: string; rules: Rule[] },
): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), renderSkillMd(opts), "utf8");
}
