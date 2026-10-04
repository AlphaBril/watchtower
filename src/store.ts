import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { watchtowerPaths } from "./paths.js";
import {
  ClassifiedFileSchema,
  MetaSchema,
  ReviewCommentsFileSchema,
  ReviewFileSchema,
  type ClassifiedFile,
  type Meta,
  type ReviewCommentsFile,
  type ReviewFile,
} from "./schemas.js";

/** Reads a JSON file and validates it against `schema`, failing loud on drift. */
export async function readValidated<T extends z.ZodType>(
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
      `${label} at ${path} does not match schema:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/** Like readValidated, but returns `fallback` when the file doesn't exist yet. */
export async function readValidatedOr<T extends z.ZodType>(
  path: string,
  schema: T,
  label: string,
  fallback: z.infer<T>,
): Promise<z.infer<T>> {
  try {
    await readFile(path);
  } catch {
    return fallback;
  }
  return readValidated(path, schema, label);
}

/** Every PR with a valid v2 cache, oldest first-review first. */
export async function listCachedMetas(repoRoot?: string): Promise<Meta[]> {
  const dir = join(watchtowerPaths(repoRoot).root, "cache", "prs");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const metas: Meta[] = [];
  for (const e of entries.filter((e) => /^\d+$/.test(e))) {
    try {
      metas.push(await readMeta(Number(e), repoRoot));
    } catch {
      // v1 or partial cache — re-run `watchtower ingest`.
    }
  }
  const key = (m: Meta) => m.reviewedAt ?? m.createdAt;
  return metas.sort((a, b) => key(a).localeCompare(key(b)));
}

export function readMeta(pr: number, repoRoot?: string): Promise<Meta> {
  return readValidated(watchtowerPaths(repoRoot).meta(pr), MetaSchema, "meta.json");
}

export function readDiff(pr: number, repoRoot?: string): Promise<string> {
  return readFile(watchtowerPaths(repoRoot).diff(pr), "utf8");
}

export function readTruth(pr: number, repoRoot?: string): Promise<ReviewCommentsFile> {
  return readValidated(
    watchtowerPaths(repoRoot).reviewComments(pr),
    ReviewCommentsFileSchema,
    "review_comments.json",
  );
}

export function readClassified(pr: number, repoRoot?: string): Promise<ClassifiedFile> {
  return readValidated(
    watchtowerPaths(repoRoot).classified(pr),
    ClassifiedFileSchema,
    "classified.json",
  );
}

export function readReview(pr: number, repoRoot?: string): Promise<ReviewFile> {
  return readValidated(watchtowerPaths(repoRoot).review(pr), ReviewFileSchema, "review.json");
}
