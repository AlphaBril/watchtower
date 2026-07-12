import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Writes `data` as pretty JSON, creating parent directories as needed. */
export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Writes raw text, creating parent directories as needed. */
export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
