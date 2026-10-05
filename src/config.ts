import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { watchtowerPaths } from "./paths.js";

export const ModelsSchema = z.object({
  classify: z.string().default("claude-haiku-4-5-20251001"),
  learn: z.string().default("claude-opus-5-5"),
  review: z.string().default("claude-sonnet-5"),
  judge: z.string().default("claude-opus-5-5"),
  /** compact: merges near-duplicate rules. */
  merge: z.string().default("claude-sonnet-5"),
  /** compact: checks each rule against the repo — cheap, many calls. */
  audit: z.string().default("claude-haiku-4-5-20251001"),
});

export const ConfigSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  /** Target developer's GitHub login — the reviewer whose concerns we learn. */
  targetDev: z.string().min(1),
  /** Repo scope, "owner/repo". */
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must be 'owner/repo'"),
  /** Local clone of the target repo; review sandboxes are git worktrees of it. */
  localRepoPath: z.string().optional(),
  /**
   * Train/test split (ISO date). PRs the dev first reviewed before this date
   * are learned from; PRs reviewed on/after it are held out for `evaluate`.
   */
  trainUntil: z.string().optional(),
  /** Skill name; also the personal skill dir `~/.claude/skills/<skillName>/`. */
  skillName: z.string().regex(/^[a-z0-9-]+$/).optional(),
  /**
   * Where `publish` puts the rules in the target repo (read by CI). Kept out
   * of `.claude/` so teammates' Claude Code sessions never load them.
   */
  rulesPath: z.string().optional(),
  models: ModelsSchema.default(ModelsSchema.parse({})),
  /** Probation/no-rule findings need at least this confidence to be posted inline. */
  postThreshold: z.number().min(0).max(1).default(0.85),
  /** Hard spend cap per single agent call, in USD. */
  maxBudgetUsd: z.number().positive().default(3),
});

export type Config = z.infer<typeof ConfigSchema>;

export function skillName(config: Config): string {
  return config.skillName ?? `${config.targetDev.toLowerCase()}-review`;
}

/** Repo-relative rules folder in the target repo. */
export function repoRulesPath(config: Config): string {
  return (config.rulesPath ?? `.github/review-rules/${skillName(config)}`).replace(/\/$/, "");
}

const TOKEN_ENV = "GITHUB_TOKEN";

/** Reads the PAT from the environment (or `.env`, loaded at startup). */
export function githubToken(): string {
  const token = process.env[TOKEN_ENV];
  if (!token) {
    throw new Error(
      `Missing ${TOKEN_ENV}. Put it in .env (see .env.example) or export it.`,
    );
  }
  return token;
}

/**
 * Reads `.watchtower/config.json`. In CI there is no config file, so the
 * config can instead come from env: WATCHTOWER_DEV plus WATCHTOWER_REPO (or
 * GitHub Actions' GITHUB_REPOSITORY).
 */
export async function readConfig(repoRoot?: string): Promise<Config> {
  const { config } = watchtowerPaths(repoRoot);
  let raw: string;
  try {
    raw = await readFile(config, "utf8");
  } catch {
    const dev = process.env.WATCHTOWER_DEV;
    const repo = process.env.WATCHTOWER_REPO ?? process.env.GITHUB_REPOSITORY;
    if (dev && repo) {
      return ConfigSchema.parse({
        targetDev: dev,
        repo,
        ...(process.env.WATCHTOWER_SKILL && { skillName: process.env.WATCHTOWER_SKILL }),
        ...(process.env.WATCHTOWER_RULES_PATH && { rulesPath: process.env.WATCHTOWER_RULES_PATH }),
      });
    }
    throw new Error(
      `No config found at ${config}. Run \`watchtower setup\` first ` +
        `(or set WATCHTOWER_DEV and WATCHTOWER_REPO in CI).`,
    );
  }
  const json = JSON.parse(raw) as Record<string, unknown>;
  // v1 configs carried loop settings that no longer exist; upgrade in place.
  if (json.schemaVersion === 1) json.schemaVersion = 2;
  return ConfigSchema.parse(json);
}

export async function writeConfig(
  config: Config,
  repoRoot?: string,
): Promise<void> {
  const { config: configPath } = watchtowerPaths(repoRoot);
  const validated = ConfigSchema.parse(config);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(validated, null, 2) + "\n", "utf8");
}
