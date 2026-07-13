import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, relative, basename, extname } from "node:path";

/**
 * Watchtower Policy Format Guard
 *
 * Deterministically validates every write/edit to `.watchtower/policies/*.md`
 * against the strict policy-file schema. When a call fails validation the
 * extension blocks it and returns a specific diagnostic naming the offending
 * field; this diagnostic is fed back into the agent's conversation as a tool
 * error, so the model self-corrects on the next turn.
 *
 * This is belt-and-braces enforcement for the `learn` agent's output format,
 * whose prompt already specifies the schema. The guard makes it a technical
 * guarantee rather than a prompt-adherence question.
 *
 * Schema (see projects/watchtower/.pi/agents/watchtower/learn.md):
 *   ---
 *   id: <kebab-slug, matches filename stem>
 *   title: <human-readable, non-empty>
 *   sourceComments:
 *     - gh:<numeric-id>
 *     ...
 *   confidence: <float 0.0–1.0>
 *   validationScore: null
 *   version: <positive integer>
 *   createdFromPr: <positive integer>
 *   ---
 *
 *   <plain prose body — no `# Policy:` heading, no `## Rule` / `## Rationale`
 *    / `## Applies to` H2 sections, no `**Source:**` bold-labelled lines>
 */

const GUARDED_TOOLS = ["write", "edit"];
const POLICIES_DIR = ".watchtower/policies";
const REQUIRED_KEYS_IN_ORDER = [
  "id",
  "title",
  "sourceComments",
  "confidence",
  "validationScore",
  "version",
  "createdFromPr",
] as const;

// Forbidden body patterns — the exact wrong renderings we've observed.
const FORBIDDEN_BODY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^#\s+Policy:/m, label: "`# Policy: ...` markdown heading" },
  { re: /^\*\*Source:\*\*/m, label: "`**Source:**` bold-labelled line" },
  { re: /^\*\*Reviewer:\*\*/m, label: "`**Reviewer:**` bold-labelled line" },
  { re: /^\*\*Date:\*\*/m, label: "`**Date:**` bold-labelled line" },
  { re: /^\*\*Confidence:\*\*/m, label: "`**Confidence:**` bold-labelled line" },
  { re: /^\*\*Version:\*\*/m, label: "`**Version:**` bold-labelled line" },
  { re: /^##\s+Rule\s*$/m, label: "`## Rule` H2 section" },
  { re: /^##\s+Rationale\s*$/m, label: "`## Rationale` H2 section" },
  { re: /^##\s+Applies to\s*$/m, label: "`## Applies to` H2 section" },
];

interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function validatePolicyFile(filePath: string, contents: string): ValidationResult {
  const errors: string[] = [];

  // 1. Must start immediately with the opening `---` (no BOM, no blank line).
  if (!contents.startsWith("---\n") && !contents.startsWith("---\r\n")) {
    errors.push(
      "File must begin with a YAML frontmatter delimiter `---` on the very first line (no BOM, no leading whitespace, no `# Policy:` heading).",
    );
    return { ok: false, errors };
  }

  // 2. Split frontmatter / body.
  const fmMatch = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    errors.push("Could not find closing `---` for YAML frontmatter.");
    return { ok: false, errors };
  }
  const fmBlock = fmMatch[1];
  const body = fmMatch[2] ?? "";

  // 3. Parse frontmatter keys, preserving order.
  const keyOrder: string[] = [];
  const values: Record<string, string> = {};
  const listItems: Record<string, string[]> = {};
  let currentListKey: string | null = null;

  const lines = fmBlock.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === "") continue;

    // YAML list continuation, e.g. "  - gh:123"
    const listItemMatch = line.match(/^\s+-\s+(.*)$/);
    if (listItemMatch && currentListKey) {
      listItems[currentListKey].push(listItemMatch[1].trim());
      continue;
    }

    // Top-level "key: value" (value optional — empty means the list follows)
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kvMatch) {
      errors.push(`Frontmatter line not recognized: ${JSON.stringify(line)}`);
      currentListKey = null;
      continue;
    }
    const [, key, rawValue] = kvMatch;
    keyOrder.push(key);
    if (rawValue === "") {
      // A block follows — treat as list container for now.
      listItems[key] = [];
      currentListKey = key;
    } else {
      values[key] = rawValue;
      currentListKey = null;
    }
  }

  // 4. Required keys, exact order, no extras.
  const required = new Set<string>(REQUIRED_KEYS_IN_ORDER);
  const missing = REQUIRED_KEYS_IN_ORDER.filter((k) => !keyOrder.includes(k));
  if (missing.length > 0) {
    errors.push(`Missing required frontmatter keys: ${missing.join(", ")}.`);
  }
  const unknown = keyOrder.filter((k) => !required.has(k));
  if (unknown.length > 0) {
    errors.push(`Unknown frontmatter keys (not in schema): ${unknown.join(", ")}.`);
  }
  // Order check (only if all required keys are present)
  if (missing.length === 0 && unknown.length === 0) {
    const expected = REQUIRED_KEYS_IN_ORDER.join(",");
    const actual = keyOrder.join(",");
    if (expected !== actual) {
      errors.push(
        `Frontmatter keys must appear in this exact order: ${REQUIRED_KEYS_IN_ORDER.join(", ")}. Got: ${keyOrder.join(", ")}.`,
      );
    }
  }

  // 5. Per-field validation.

  // id — kebab-case, matches filename stem
  const stem = basename(filePath, extname(filePath));
  if ("id" in values) {
    const id = values.id.trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
      errors.push(`\`id\` must be kebab-case (lowercase a-z, 0-9, hyphens). Got: ${JSON.stringify(id)}.`);
    } else if (id !== stem) {
      errors.push(`\`id\` (${JSON.stringify(id)}) must equal the filename stem (${JSON.stringify(stem)}).`);
    }
  }

  // title — non-empty string, no leading "Policy:"
  if ("title" in values) {
    const t = values.title.trim().replace(/^["']|["']$/g, "");
    if (t.length === 0) errors.push("`title` must be a non-empty string.");
    if (/^Policy:\s*/i.test(t)) {
      errors.push('`title` must NOT start with "Policy:" — the reader knows it is a policy.');
    }
  }

  // sourceComments — YAML list form only, each item `gh:<digits>`
  if ("sourceComments" in listItems || "sourceComments" in values) {
    if ("sourceComments" in values && values.sourceComments.trim() !== "") {
      // Inline value present — this is wrong unless it's a `[]` empty list.
      errors.push(
        "`sourceComments` must be a YAML list with each entry on its own line prefixed by `  - `. Do not use inline JSON-style arrays.",
      );
    }
    const items = listItems.sourceComments ?? [];
    if (items.length === 0) {
      errors.push("`sourceComments` must contain at least one entry of the form `- gh:<numeric-id>`.");
    }
    for (const item of items) {
      const cleaned = item.replace(/^["']|["']$/g, "").trim();
      if (!/^gh:\d+$/.test(cleaned)) {
        errors.push(`\`sourceComments\` entry must match \`gh:<digits>\`. Got: ${JSON.stringify(item)}.`);
      }
    }
  }

  // confidence — float 0.0–1.0
  if ("confidence" in values) {
    const raw = values.confidence.trim();
    const n = Number(raw);
    if (!/^-?\d+(\.\d+)?$/.test(raw) || Number.isNaN(n) || n < 0 || n > 1) {
      errors.push(`\`confidence\` must be a numeric literal between 0.0 and 1.0. Got: ${JSON.stringify(raw)}.`);
    }
  }

  // validationScore — literally `null`
  if ("validationScore" in values) {
    if (values.validationScore.trim() !== "null") {
      errors.push(
        `\`validationScore\` must be literally the token \`null\` (unquoted). Got: ${JSON.stringify(values.validationScore)}.`,
      );
    }
  }

  // version — positive integer literal
  if ("version" in values) {
    const raw = values.version.trim();
    if (!/^[1-9]\d*$/.test(raw)) {
      errors.push(`\`version\` must be a positive integer literal (no quotes, no decimals). Got: ${JSON.stringify(raw)}.`);
    }
  }

  // createdFromPr — positive integer literal
  if ("createdFromPr" in values) {
    const raw = values.createdFromPr.trim();
    if (!/^[1-9]\d*$/.test(raw)) {
      errors.push(
        `\`createdFromPr\` must be a positive integer literal (no quotes). Got: ${JSON.stringify(raw)}.`,
      );
    }
  }

  // 6. Body — forbidden patterns
  for (const { re, label } of FORBIDDEN_BODY_PATTERNS) {
    if (re.test(body)) {
      errors.push(`Body contains forbidden pattern: ${label}. Use plain prose only.`);
    }
  }
  if (body.trim().length === 0) {
    errors.push("Body prose is empty — write 1–2 short paragraphs describing the concern, when to flag it, and the fix.");
  }

  return { ok: errors.length === 0, errors };
}

function isPolicyPath(cwd: string, inputPath: string): boolean {
  const abs = resolve(cwd, inputPath);
  const rel = relative(cwd, abs);
  if (!rel.startsWith(POLICIES_DIR + "/")) return false;
  if (!rel.endsWith(".md")) return false;
  return true;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!GUARDED_TOOLS.includes(event.toolName)) return undefined;

    const input = event.input as Record<string, unknown>;
    const inputPath = (input.path as string | undefined) ?? undefined;
    if (!inputPath || !isPolicyPath(ctx.cwd, inputPath)) return undefined;

    // For `write` we validate the payload directly.
    if (event.toolName === "write") {
      const contents = (input.content as string | undefined) ?? "";
      const { ok, errors } = validatePolicyFile(inputPath, contents);
      if (!ok) {
        return {
          block: true,
          reason:
            `POLICY FORMAT REJECTED for ${inputPath}. Fix these issues and retry, matching <policy_file_skeleton> exactly:\n` +
            errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n"),
        };
      }
      return undefined;
    }

    // For `edit` we apply the patch(es) against the current file contents and
    // validate the result — this catches partial edits that would leave the
    // file malformed.
    if (event.toolName === "edit") {
      const abs = resolve(ctx.cwd, inputPath);
      let current: string;
      try {
        const { readFile } = await import("node:fs/promises");
        current = await readFile(abs, "utf-8");
      } catch {
        // File doesn't exist yet — nothing to validate; write will handle it.
        return undefined;
      }

      const edits =
        (input.edits as Array<{ oldText: string; newText: string }> | undefined) ??
        (input.oldText !== undefined
          ? [{ oldText: input.oldText as string, newText: (input.newText as string) ?? "" }]
          : undefined);

      if (!edits || edits.length === 0) return undefined;

      let projected = current;
      for (const { oldText, newText } of edits) {
        if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
        const idx = projected.indexOf(oldText);
        if (idx === -1) {
          // Let the edit tool itself surface the "not found" error.
          return undefined;
        }
        projected =
          projected.slice(0, idx) + newText + projected.slice(idx + oldText.length);
      }

      const { ok, errors } = validatePolicyFile(inputPath, projected);
      if (!ok) {
        return {
          block: true,
          reason:
            `POLICY FORMAT REJECTED: the proposed edit would leave ${inputPath} malformed. Adjust the patch and retry:\n` +
            errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n"),
        };
      }
      return undefined;
    }

    return undefined;
  });
}
