import { loadPrompt, runAgent, type CostLog } from "./agent.js";
import { silent, type Log } from "./log.js";
import type { Config } from "./config.js";
import { writeJson } from "./fsutil.js";
import { watchtowerPaths } from "./paths.js";
import {
  ClassifyOutputSchema,
  type Classification,
  type ClassifiedFile,
} from "./schemas.js";
import { readClassified, readMeta, readTruth } from "./store.js";

/**
 * Classifies every dev comment on a PR (actionable / question / nit /
 * retraction / reply / praise + severity + needsOutsideContext) and caches
 * the result in truth/<pr#>/classified.json. Cached results are reused when
 * they cover every current comment id.
 */
export async function classifyPr(
  pr: number,
  config: Config,
  opts: { costs?: CostLog; force?: boolean; log?: Log } = {},
): Promise<ClassifiedFile> {
  const log = opts.log ?? silent;
  const truth = await readTruth(pr);
  const ids = truth.comments.map((c) => c.id);

  if (!opts.force) {
    try {
      const cached = await readClassified(pr);
      const have = new Set(cached.items.map((i) => i.id));
      if (ids.every((id) => have.has(id))) {
        log(`classify: cached (${ids.length} comment(s))`);
        return cached;
      }
    } catch {
      // not classified yet
    }
  }

  let items: Classification[] = [];
  if (ids.length > 0) {
    const meta = await readMeta(pr);
    const input = {
      pr: meta.number,
      title: meta.title,
      comments: truth.comments.map((c) => ({
        id: c.id,
        kind: c.kind,
        path: c.path,
        line: c.line,
        inReplyToId: c.inReplyToId,
        body: c.body,
        diffHunk: c.diffHunk.slice(-1500),
      })),
    };
    const out = await runAgent({
      agent: "classify",
      pr,
      model: config.models.classify,
      systemPrompt: await loadPrompt("classify"),
      prompt: "Classify these review comments.\n\n```json\n" + JSON.stringify(input, null, 2) + "\n```",
      schema: ClassifyOutputSchema,
      maxBudgetUsd: config.maxBudgetUsd,
      costs: opts.costs,
      log: opts.log,
    });
    items = reconcile(ids, out.items);
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
    log(`classify: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")}`);
  }

  const file: ClassifiedFile = { schemaVersion: 1, pr, items };
  await writeJson(watchtowerPaths().classified(pr), file);
  return file;
}

/** Keeps exactly one item per known id, in order; unknown ids are dropped. */
function reconcile(ids: string[], items: Classification[]): Classification[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return ids.map(
    (id) =>
      byId.get(id) ?? {
        id,
        category: "reply",
        severity: "nit",
        needsOutsideContext: false,
        gist: "unclassified (missing from classifier output)",
      },
  );
}
