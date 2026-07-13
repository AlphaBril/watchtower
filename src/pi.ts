import { execa } from "execa";
import { withReviewMarker } from "./marker.js";

export type PiAgent = "learn" | "review" | "judge";

const EXTENSIONS = [
  ".pi/extensions/isolation-guard.ts",
  ".pi/extensions/policy-format-guard.ts",
];

export interface PiResult {
  agent: PiAgent;
  pr: number;
}

/**
 * Invokes a pi agent:
 *   pi -p -e isolation-guard.ts -e policy-format-guard.ts "/<agent> <pr#>"
 *
 * `-p` runs non-interactively and prints the result on stdout. Both guard
 * extensions are passed explicitly on every call (rather than relying on
 * settings.json auto-discovery) so their handlers are guaranteed to load. The
 * isolation guard is inert unless the review marker is present, and the
 * policy-format guard only fires on writes to policies/*.md — both are safe on
 * every agent.
 *
 * The `review` agent is automatically wrapped with the review marker so the
 * guard blocks its access to truth/ and runs/.
 *
 * stdio is fully inherited so pi sees a real stdin/stdout — matching a manual
 * terminal invocation. (With execa's default piped stdin, pi blocks waiting on
 * an EOF that never arrives and appears to hang.) We don't capture stdout
 * because every agent result is read back from files, never from stdout.
 */
export async function runPi(
  agent: PiAgent,
  pr: number,
  repoRoot: string = process.cwd(),
): Promise<PiResult> {
  const invoke = () => spawnPi(agent, pr, repoRoot);
  return agent === "review"
    ? withReviewMarker(invoke, repoRoot)
    : invoke();
}

async function spawnPi(
  agent: PiAgent,
  pr: number,
  cwd: string,
): Promise<PiResult> {
  const args = [
    "-p",
    ...EXTENSIONS.flatMap((e) => ["-e", e]),
    `/${agent} ${pr}`,
  ];
  try {
    await execa("pi", args, { cwd, stdio: "inherit" });
    return { agent, pr };
  } catch (err) {
    const e = err as { shortMessage?: string; exitCode?: number };
    throw new Error(
      `pi ${agent} ${pr} failed (exit ${e.exitCode ?? "?"}): ` +
        `${e.shortMessage ?? String(err)}`,
    );
  }
}
