import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * Loads `.env` from the working directory into process.env. Values in `.env`
 * win over the inherited environment: the project file is the explicit
 * source for watchtower's secrets (GITHUB_TOKEN, ANTHROPIC_API_KEY), so a
 * stale value exported by the shell (direnv/nix shellHook) can't shadow it.
 * A missing file is fine — CI passes secrets through the environment.
 */
export function loadDotEnv(dir: string = process.cwd()): string[] {
  let contents: string;
  try {
    contents = readFileSync(resolve(dir, ".env"), "utf8");
  } catch {
    return [];
  }
  // Empty values (`KEY=` left from .env.example) are ignored, not applied.
  const entries = Object.entries(parseEnv(contents)).filter(([, v]) => v !== undefined && v !== "");
  for (const [key, value] of entries) process.env[key] = value;
  return entries.map(([key]) => key);
}
