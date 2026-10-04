import { query, type HookCallback, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { writeJson } from "./fsutil.js";
import { kb, secs, silent, tokens, type Log } from "./log.js";

/**
 * Runs one Claude agent through the Agent SDK and returns its structured
 * output, validated with zod. This replaces the v1 `pi` subprocess:
 *
 * - Agents never write files. Output comes back as `structured_output`
 *   (SDK `outputFormat: json_schema`) and watchtower writes everything, so
 *   there are no stale output files and no write-side format guards.
 * - No filesystem settings are loaded (`settingSources: []`): a reviewed
 *   repo's `.claude/settings.json` hooks or CLAUDE.md never run or leak in.
 * - Tools default to none. Agents that need code context get read-only
 *   tools plus a PreToolUse hook confining every path to `sandboxRoot`.
 */

const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

/**
 * Which Claude Code binary the SDK spawns. The SDK bundles a generic-Linux
 * build that NixOS can't execute, so: WATCHTOWER_CLAUDE_PATH if set, else on
 * NixOS the `claude` on PATH (e.g. the nixpkgs claude-code), else the bundle.
 */
export function claudeExecutable(): string | undefined {
  const explicit = process.env.WATCHTOWER_CLAUDE_PATH;
  if (explicit) return explicit;
  if (!existsSync("/etc/NIXOS")) return undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "claude");
    if (dir && existsSync(candidate)) return candidate;
  }
  throw new Error(
    "NixOS can't run the SDK's bundled Claude Code binary. Install claude-code from nixpkgs " +
      "or set WATCHTOWER_CLAUDE_PATH in .env to a working `claude`.",
  );
}

export async function loadPrompt(name: string): Promise<string> {
  return readFile(resolve(PROMPTS_DIR, `${name}.md`), "utf8");
}

export interface AgentRun {
  agent: string;
  pr: number | null;
  model: string;
  costUsd: number;
  turns: number;
  durationMs: number;
}

/** Accumulates per-call cost so commands can write runs/<ts>/costs.json. */
export class CostLog {
  readonly runs: AgentRun[] = [];
  get totalUsd(): number {
    return Math.round(this.runs.reduce((s, r) => s + r.costUsd, 0) * 100) / 100;
  }
  async write(path: string): Promise<void> {
    await writeJson(path, { schemaVersion: 1, totalUsd: this.totalUsd, runs: this.runs });
  }
}

export interface RunAgentOptions<T extends z.ZodType> {
  agent: string;
  pr?: number;
  model: string;
  systemPrompt: string;
  prompt: string;
  schema: T;
  /** Read-only tools to expose (e.g. ["Read", "Grep", "Glob"]); default none. */
  tools?: string[];
  /** Working directory; required with tools. Paths outside it are denied. */
  sandboxRoot?: string;
  maxTurns?: number;
  maxBudgetUsd: number;
  costs?: CostLog;
  /** Progress lines: start, tool calls, retries, heartbeat, finish. */
  log?: Log;
}

const HEARTBEAT_MS = 20_000;

/** One-line description of a tool call, e.g. `Read src/a.ts`. */
function describeToolUse(name: string, input: Record<string, unknown>): string {
  const arg = input.file_path ?? input.pattern ?? input.path;
  const where = name === "Grep" && typeof input.path === "string" ? ` in ${input.path}` : "";
  return `${name} ${typeof arg === "string" ? arg : ""}${where}`.trim();
}

export async function runAgent<T extends z.ZodType>(opts: RunAgentOptions<T>): Promise<z.infer<T>> {
  const tools = opts.tools ?? [];
  if (tools.length > 0 && !opts.sandboxRoot) {
    throw new Error(`agent ${opts.agent}: tools require a sandboxRoot`);
  }

  const executable = claudeExecutable();
  const stream = query({
    prompt: opts.prompt,
    options: {
      ...(executable && { pathToClaudeCodeExecutable: executable }),
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      tools,
      allowedTools: tools,
      ...(opts.sandboxRoot && {
        cwd: opts.sandboxRoot,
        hooks: {
          PreToolUse: [{ matcher: tools.join("|"), hooks: [confineTo(opts.sandboxRoot)] }],
        },
      }),
      settingSources: [],
      persistSession: false,
      maxTurns: opts.maxTurns ?? (tools.length > 0 ? 40 : 4),
      maxBudgetUsd: opts.maxBudgetUsd,
      outputFormat: { type: "json_schema", schema: outputSchema(opts.schema) },
    },
  });

  const log = opts.log ?? silent;
  const started = Date.now();
  let turns = 0;
  log(`${opts.agent}: calling ${opts.model} · prompt ${kb(opts.prompt.length)} (~${tokens(opts.prompt.length)} tokens)`);
  // Long single-turn calls (learn/judge on big diffs) are otherwise silent.
  const heartbeat = setInterval(
    () => log(`${opts.agent}: still working… ${secs(Date.now() - started)}${turns ? ` · ${turns} turn(s)` : ""}`),
    HEARTBEAT_MS,
  );

  try {
    for await (const message of stream) {
      if (message.type === "assistant") {
        turns++;
        for (const block of message.message.content) {
          if (block.type === "tool_use") log(`${opts.agent}: → ${describeToolUse(block.name, block.input as Record<string, unknown>)}`);
        }
        continue;
      }
      if (message.type === "system" && message.subtype === "api_retry") {
        log(
          `${opts.agent}: API ${message.error_status ?? "error"} — retry ${message.attempt}/${message.max_retries} in ${secs(message.retry_delay_ms)}`,
        );
        continue;
      }
      if (message.type !== "result") continue;
      log(`${opts.agent}: done in ${secs(Date.now() - started)} · ${message.num_turns} turn(s) · $${message.total_cost_usd.toFixed(3)}`);
      return finish(opts, message);
    }
    throw new Error(`agent ${opts.agent}: stream ended without a result`);
  } finally {
    clearInterval(heartbeat);
  }
}

/** Records cost, then returns the validated structured output or throws. */
function finish<T extends z.ZodType>(opts: RunAgentOptions<T>, message: SDKResultMessage): z.infer<T> {
  opts.costs?.runs.push({
    agent: opts.agent,
    pr: opts.pr ?? null,
    model: opts.model,
    costUsd: message.total_cost_usd,
    turns: message.num_turns,
    durationMs: message.duration_ms,
  });
  const where = `agent ${opts.agent}${opts.pr ? ` (PR #${opts.pr})` : ""}`;
  if (message.subtype !== "success" || message.is_error) {
    const detail = message.subtype === "success" ? message.result : message.errors.join("; ");
    throw new Error(`${where} failed: ${message.subtype}${detail ? ` — ${detail}` : ""}`);
  }
  const parsed = opts.schema.safeParse(message.structured_output);
  if (!parsed.success) {
    throw new Error(`${where} returned output that does not match its schema:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * JSON Schema for structured output. Claude Code's validator rejects zod's
 * default `$schema: draft/2020-12` URI, so emit draft-07 without `$schema`.
 */
export function outputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { target: "draft-07" }) as Record<string, unknown>;
  return rest;
}

/** True when `path` (absolute or relative to root) stays inside `root`. */
export function isInside(root: string, path: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * PreToolUse hook: denies any Read/Grep/Glob whose path argument resolves
 * outside the sandbox. Grep/Glob without a path default to cwd (= sandbox).
 */
export function confineTo(root: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    const candidates = [args.file_path, args.path].filter((p): p is string => typeof p === "string");
    // A Glob pattern is itself path-like (`../../**`); Grep's pattern is a regex.
    if (input.tool_name === "Glob" && typeof args.pattern === "string") {
      const base = typeof args.path === "string" ? resolve(root, args.path) : root;
      candidates.push(resolve(base, args.pattern.replace(/[*?[{].*$/, "") || "."));
    }
    const outside = candidates.find((p) => !isInside(root, p));
    if (!outside) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Path ${outside} is outside the review sandbox. Only files of the repository under review are readable.`,
      },
    };
  };
}
