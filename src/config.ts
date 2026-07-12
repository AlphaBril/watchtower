import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { watchtowerPaths } from "./paths.js";

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** Target developer's GitHub login — the reviewer whose style we clone. */
  targetDev: z.string().min(1),
  /** Repo scope, "owner/repo". */
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must be 'owner/repo'"),
  /** Score at/above which a PR's policies are considered validated. */
  validationThreshold: z.number().min(0).max(1).default(0.7),
  /** Max refine-on-mismatch iterations before flagging the developer. */
  maxIterations: z.number().int().min(1).default(3),
});

export type Config = z.infer<typeof ConfigSchema>;

const TOKEN_ENV = "GITHUB_TOKEN";

/** Reads the PAT from the environment. Never stored on disk. */
export function githubToken(): string {
  const token = process.env[TOKEN_ENV];
  if (!token) {
    throw new Error(
      `Missing ${TOKEN_ENV}. Export a GitHub PAT, e.g. \`export ${TOKEN_ENV}=ghp_...\``,
    );
  }
  return token;
}

export async function readConfig(repoRoot?: string): Promise<Config> {
  const { config } = watchtowerPaths(repoRoot);
  let raw: string;
  try {
    raw = await readFile(config, "utf8");
  } catch {
    throw new Error(
      `No config found at ${config}. Run \`watchtower setup\` first.`,
    );
  }
  return ConfigSchema.parse(JSON.parse(raw));
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
