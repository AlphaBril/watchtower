import { readdir, readFile } from "node:fs/promises";
import type { z } from "zod";
import { watchtowerPaths } from "./paths.js";
import {
  CloneCommentsFileSchema,
  MetaSchema,
  ReviewCommentsFileSchema,
  type CloneCommentsFile,
  type Meta,
  type ReviewCommentsFile,
} from "./schemas.js";

/** Reads a JSON file and validates it against `schema`, failing loud on drift. */
async function readValidated<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  label: string,
): Promise<z.infer<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`Missing ${label} at ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${label} at ${path}: ${String(e)}`);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `${label} at ${path} does not match schema:\n${result.error.toString()}`,
    );
  }
  return result.data;
}

export function readMeta(pr: number, repoRoot?: string): Promise<Meta> {
  return readValidated(watchtowerPaths(repoRoot).meta(pr), MetaSchema, "meta.json");
}

export function readTruth(
  pr: number,
  repoRoot?: string,
): Promise<ReviewCommentsFile> {
  return readValidated(
    watchtowerPaths(repoRoot).reviewComments(pr),
    ReviewCommentsFileSchema,
    "review_comments.json",
  );
}

export function readCloneComments(
  pr: number,
  repoRoot?: string,
): Promise<CloneCommentsFile> {
  return readValidated(
    watchtowerPaths(repoRoot).cloneComments(pr),
    CloneCommentsFileSchema,
    "clone_comments.json",
  );
}

/** Lists policy slugs (filenames without .md) currently on disk. */
export async function listPolicies(repoRoot?: string): Promise<string[]> {
  const { policiesDir } = watchtowerPaths(repoRoot);
  try {
    const files = await readdir(policiesDir);
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}
