import type { Command } from "commander";
import { execa } from "execa";
import { cp } from "node:fs/promises";
import { CostLog } from "../agent.js";
import {
  applyMerges,
  auditRule,
  groupCandidates,
  decide,
  mergeCluster,
  toolingFiles,
  type MergeApplied,
} from "../compact.js";
import { renderCompactionReport, type CompactionRecord } from "../compact-report.js";
import { readConfig, skillName } from "../config.js";
import { writeJson, writeText } from "../fsutil.js";
import { secs, stepLogger } from "../log.js";
import { runStamp, watchtowerPaths } from "../paths.js";
import { syncPersonalSkill } from "../personal.js";
import { mapPool } from "../pool.js";
import { readRules, writeRule, writeSkillIndex } from "../rules.js";
import { withSandbox } from "../sandbox.js";
import type { Rule } from "../schemas.js";

const git = (repo: string, args: string[]) => execa("git", ["-C", repo, ...args]);

/** origin's default branch, e.g. "main" (falls back to "main"). */
async function defaultRemoteBranch(repo: string): Promise<string> {
  try {
    const { stdout } = await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    return stdout.trim().replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

export function registerCompact(program: Command): void {
  program
    .command("compact")
    .description("Merge duplicate rules, audit every rule against the repo, retire/rescope, recommend tooling")
    .option("--ref <ref>", "commit/branch to audit against (default: origin's default branch, freshly fetched)")
    .option("--concurrency <n>", "agent calls in parallel", (v) => parseInt(v, 10), 5)
    .action(async (opts: { ref?: string; concurrency: number }) => {
      const config = await readConfig();
      if (!config.localRepoPath) throw new Error("Set the local clone: `watchtower setup --repo-path <path>`.");
      const repo = config.localRepoPath;
      const name = skillName(config);
      const paths = watchtowerPaths();
      const skillDir = paths.skillDir(name);
      const ts = runStamp();
      const runDir = paths.runDir(ts);
      const startedAt = new Date().toISOString();
      const costs = new CostLog();
      const log = stepLogger("  ");

      let rules = await readRules(skillDir);
      const before = rules.filter((r) => r.status !== "retired").length;
      if (before === 0) throw new Error("No live rules — run `watchtower learn` first.");

      let ref = opts.ref;
      if (!ref) {
        const branch = await defaultRemoteBranch(repo);
        await git(repo, ["fetch", "--quiet", "origin", branch]);
        ref = `origin/${branch}`;
      }
      const sha = (await git(repo, ["rev-parse", `${ref}^{commit}`])).stdout.trim();

      await cp(skillDir, `${runDir}/skill-before`, { recursive: true });
      console.log(`Compacting ${before} live rule(s) against ${ref} @ ${sha.slice(0, 12)} (backup: ${runDir}/skill-before)`);

      // ── 1. merge near-duplicates ──
      const live = rules.filter((r) => r.status !== "retired");
      const clusters = await groupCandidates(live, config, costs);
      const byId = new Map(rules.map((r) => [r.id, r]));
      console.log(`\n── Merge: ${clusters.length} group(s) of candidate duplicates (${clusters.reduce((n, c) => n + c.length, 0)} rules) ──`);
      let done = 0;
      const mergeOutputs = await mapPool(clusters, opts.concurrency, async (cluster) => {
        const out = await mergeCluster(cluster.map((id) => byId.get(id)!), config, costs);
        log(`[${++done}/${clusters.length}] ${cluster.length} rules → ${out.merges.length} merge(s)`);
        return out;
      });
      const merges: MergeApplied[] = [];
      let mergeRejected = 0;
      mergeOutputs.forEach((res, i) => {
        if (!res.ok) {
          log(`merge failed for [${clusters[i]!.join(", ")}]: ${res.error instanceof Error ? res.error.message : String(res.error)}`);
          return;
        }
        const r = applyMerges(rules, clusters[i]!, res.value);
        rules = r.rules;
        merges.push(...r.applied);
        mergeRejected += r.rejected.length;
        for (const m of r.applied) log(`merged ${m.from.join(" + ")} → ${m.id}`);
        for (const x of r.rejected) log(`rejected merge [${x.from.join(", ")}]: ${x.reason}`);
      });
      for (const r of rules) await writeRule(skillDir, r);
      await writeJson(`${runDir}/costs.json`, { totalUsd: costs.totalUsd, runs: costs.runs });

      // ── 2. audit every live rule against the repo ──
      const toAudit = rules.filter((r) => r.status !== "retired");
      console.log(`\n── Audit: ${toAudit.length} rule(s) against the repo (${opts.concurrency} in parallel) ──`);
      const records: CompactionRecord[] = await withSandbox(repo, sha, async (dir) => {
        const files = (await git(dir, ["ls-files"])).stdout.split("\n").filter(Boolean);
        const tooling = toolingFiles(files);
        log(`sandbox ready: ${files.length} tracked file(s), ${tooling.length} tooling config file(s)`);
        let n = 0;
        let cachedCount = 0;
        const results = await mapPool(toAudit, opts.concurrency, async (rule) => {
          const t0 = Date.now();
          const callCosts = new CostLog();
          const { result, cached } = await auditRule(rule, { dir, sha, files, tooling, config, costs: callCosts });
          costs.runs.push(...callCosts.runs);
          if (cached) cachedCount++;
          const d = decide(rule, result, files);
          log(
            `[${++n}/${toAudit.length}] ${rule.id} → ${d.action}` +
              ` (${result.conforming}/${result.checked} conform${result.tooling.feasible ? ", tooling ✓" : ""})` +
              (cached ? " · cached" : ` · ${secs(Date.now() - t0)} · $${callCosts.totalUsd}`),
          );
          if (n % 20 === 0) await writeJson(`${runDir}/costs.json`, { totalUsd: costs.totalUsd, runs: costs.runs });
          return { result, decision: d };
        });
        if (cachedCount) log(`${cachedCount} audit(s) reused from cache`);
        return toAudit.map((rule, i) => {
          const r = results[i]!;
          return r.ok
            ? { rule, audit: r.value.result, decision: r.value.decision, error: null }
            : { rule, audit: null, decision: null, error: r.error instanceof Error ? r.error.message : String(r.error) };
        });
      });

      // ── 3. apply decisions ──
      const next = new Map(rules.map((r) => [r.id, r]));
      for (const { rule, decision } of records) {
        if (!decision) continue;
        if (decision.action === "retire") next.set(rule.id, { ...rule, status: "retired" });
        if (decision.action === "rescope") next.set(rule.id, { ...rule, paths: decision.newPaths! });
      }
      const finalRules: Rule[] = [...next.values()];
      for (const r of finalRules) await writeRule(skillDir, r);
      await writeSkillIndex(skillDir, { name, dev: config.targetDev, repo: config.repo, rules: finalRules });
      if (await syncPersonalSkill(skillDir, name)) log(`synced personal skill /${name}`);

      // ── 4. report ──
      const report = renderCompactionReport({ ref, sha, startedAt, before, merges, mergeRejected, records, costUsd: costs.totalUsd });
      await writeText(`${runDir}/compaction.md`, report);
      await writeJson(`${runDir}/compaction.json`, {
        schemaVersion: 1,
        ref,
        sha,
        startedAt,
        before,
        merges,
        records: records.map((r) => ({ ruleId: r.rule.id, decision: r.decision, audit: r.audit, error: r.error })),
      });
      await writeJson(`${runDir}/costs.json`, { totalUsd: costs.totalUsd, runs: costs.runs });

      const count = (a: string) => records.filter((r) => r.decision?.action === a).length;
      const liveAfter = finalRules.filter((r) => r.status !== "retired").length;
      console.log(`\n═══ COMPACTION ═══`);
      console.log(`Live rules:   ${before} → ${liveAfter}`);
      console.log(`Merged away:  ${merges.reduce((n, m) => n + m.from.length - 1, 0)} (into ${merges.length})`);
      console.log(`Kept ${count("keep")} · rescoped ${count("rescope")} · retired ${count("retire")} · contested ${count("contested")} · failed ${records.filter((r) => r.error).length}`);
      console.log(`Tooling recommendations: ${records.filter((r) => r.audit?.tooling.feasible && r.decision?.action !== "retire").length}`);
      console.log(`Spend ≈ $${costs.totalUsd}`);
      console.log(`Report: ${runDir}/compaction.md`);
    });
}
