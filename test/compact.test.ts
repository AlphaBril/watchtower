import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMerges, decide, sanitizeGroups, toolingFiles } from "../src/compact.js";
import { mapPool } from "../src/pool.js";
import type { AuditOutput, Rule } from "../src/schemas.js";

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id,
  title: id.replace(/-/g, " "),
  kind: "convention",
  severity: "should",
  paths: [],
  sourceComments: ["gh:1"],
  status: "probation",
  body: `Body for ${id}.`,
  ...over,
});

const audit = (over: Partial<AuditOutput> = {}): AuditOutput => ({
  applies: true,
  checked: 8,
  conforming: 7,
  violating: 1,
  examples: [],
  alreadyEnforced: false,
  alreadyEnforcedBy: null,
  tooling: { feasible: false, kind: null, summary: null, implementation: null, effort: null },
  suggestedPaths: null,
  verdict: "keep",
  reason: "followed",
  ...over,
});

test("sanitizeGroups: known ids only, one group per id, 2..8 per group", () => {
  const known = new Set(["a", "b", "c", "d", ...Array.from({ length: 12 }, (_, i) => `x${i}`)]);
  const groups = sanitizeGroups(
    [
      ["a", "b", "b", "ghost"], // dup + unknown dropped
      ["b", "c"], // b already used → only c left → dropped
      ["c", "d"],
      Array.from({ length: 12 }, (_, i) => `x${i}`), // capped at 8
      ["ghost", "a"],
    ],
    known,
  );
  assert.deepEqual(groups.slice(0, 2), [["a", "b"], ["c", "d"]]);
  assert.equal(groups[2]!.length, 8);
  assert.equal(groups.length, 3);
});

test("applyMerges unions sources, retires originals, rejects invalid merges", () => {
  const rules = [
    rule("a", { sourceComments: ["gh:1", "gh:2"] }),
    rule("b", { sourceComments: ["gh:2", "gh:3"], status: "active" }),
    rule("c"),
    rule("outside"),
  ];
  const { rules: next, applied, rejected } = applyMerges(rules, ["a", "b", "c"], {
    merges: [
      { from: ["a", "b"], id: "a", title: "A+B", kind: "invariant", severity: "blocker", paths: ["src/**"], body: "Merged." },
      { from: ["b", "c"], id: "bc", title: "x", kind: "taste", severity: "nit", paths: [], body: "x" }, // b already used
      { from: ["c", "outside"], id: "c2", title: "x", kind: "taste", severity: "nit", paths: [], body: "x" }, // outside not in cluster
      { from: ["c"], id: "outside", title: "x", kind: "taste", severity: "nit", paths: [], body: "x" },
    ],
  });
  const get = (id: string) => next.find((r) => r.id === id)!;
  assert.deepEqual(applied, [{ id: "a", from: ["a", "b"] }]);
  assert.equal(rejected.length, 3);
  assert.deepEqual(get("a").sourceComments, ["gh:1", "gh:2", "gh:3"]);
  assert.equal(get("a").status, "active");
  assert.equal(get("a").severity, "blocker");
  assert.equal(get("b").status, "retired");
  assert.equal(get("c").status, "probation");
  assert.equal(get("outside").status, "probation");
});

test("decide: keep, rescope (only valid globs), retire, contested for strong evidence", () => {
  const files = ["apps/api/src/a.ts", "libs/ui/b.tsx"];
  assert.equal(decide(rule("r"), audit(), files).action, "keep");

  const rescoped = decide(rule("r"), audit({ verdict: "rescope", suggestedPaths: ["apps/api/**", "nowhere/**"] }), files);
  assert.equal(rescoped.action, "rescope");
  assert.deepEqual(rescoped.newPaths, ["apps/api/**"]);

  assert.equal(decide(rule("r"), audit({ verdict: "rescope", suggestedPaths: ["nowhere/**"] }), files).action, "keep");
  assert.equal(decide(rule("r"), audit({ verdict: "drop" }), files).action, "retire");
  assert.equal(decide(rule("r"), audit({ alreadyEnforced: true, alreadyEnforcedBy: "eslint eqeqeq" }), files).action, "retire");

  const strong = rule("r", { sourceComments: ["gh:1", "gh:2", "gh:3", "gh:4", "gh:5"] });
  const d = decide(strong, audit({ verdict: "drop" }), files);
  assert.equal(d.action, "contested");
  assert.match(d.reason, /5 review comments/);
});

test("toolingFiles picks lint/ts/ci config, not regular sources", () => {
  assert.deepEqual(
    toolingFiles(["package.json", "apps/api/tsconfig.json", ".github/workflows/ci.yml", "eslint.config.mjs", "src/a.ts", "libs/x/package.json"]),
    ["package.json", "apps/api/tsconfig.json", ".github/workflows/ci.yml", "eslint.config.mjs"],
  );
});

test("mapPool keeps order, bounds concurrency, captures failures", async () => {
  let inFlight = 0;
  let peak = 0;
  const res = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (n === 4) throw new Error("boom");
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(res.map((r) => (r.ok ? r.value : "err")), [10, 20, 30, "err", 50, 60]);
});
