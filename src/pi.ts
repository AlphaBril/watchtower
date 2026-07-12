import { execa } from "execa";
import { withReviewMarker } from "./marker.js";

export type PiAgent = "learn" | "review" | "judge";

const EXTENSION = ".pi/extensions/isolation-guard.ts";

export interface PiResult {
  agent: PiAgent;
  pr: number;
  /** The agent's textual result printed on stdout in `-p` mode. */
  stdout: string;
  stderr: string;
}

/**
 * Invokes a pi agent:
 *   pi -p -e .pi/extensions/isolation-guard.ts "/<agent> <pr#>"
 *
 * `-p` runs non-interactively and prints the result on stdout. The isolation
 * guard extension is passed on every call — it is inert unless the review
 * marker is present, so it is safe for learn/judge and mandatory for review.
 *
 * The `review` agent is automatically wrapped with the review marker so the
 * guard blocks its access to truth/ and runs/.
 */
export async function runPi(
  agent: PiAgent,
  pr: number,
  repoRoot: string = process.cwd(),
): Promise<PiResult> {
  const invoke = () => spawnPi(agent, pr, repoRoot);
  const result =
    agent === "review"
      ? await withReviewMarker(invoke, repoRoot)
      : await invoke();
  return result;
}

async function spawnPi(
  agent: PiAgent,
  pr: number,
  cwd: string,
): Promise<PiResult> {
  const args = ["-p", "-e", EXTENSION, `/${agent} ${pr}`];
  try {
    const { stdout, stderr } = await execa("pi", args, { cwd });
    return { agent, pr, stdout, stderr };
  } catch (err) {
    const e = err as { shortMessage?: string; stderr?: string; exitCode?: number };
    throw new Error(
      `pi ${agent} ${pr} failed (exit ${e.exitCode ?? "?"}): ` +
        `${e.shortMessage ?? String(err)}${e.stderr ? `\n${e.stderr}` : ""}`,
    );
  }
}
