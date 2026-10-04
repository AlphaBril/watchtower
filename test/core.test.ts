import { test } from "node:test";
import assert from "node:assert/strict";
import { isInside, confineTo } from "../src/agent.js";
import { changedPaths, commentableLines, filterDiff, splitDiff } from "../src/diff.js";
import { globToRegExp, matchesAny } from "../src/glob.js";
import { marker, parseMarker } from "../src/post.js";
import { placeFinding } from "../src/review.js";
import { applicableRules, applyLearnOps, parseRule, serializeRule, validateRule } from "../src/rules.js";
import type { Rule } from "../src/schemas.js";
import { proposedStatus, ruleStats } from "../src/stats.js";

const DIFF = `diff --git a/src/auth/state.ts b/src/auth/state.ts
index 111..222 100644
--- a/src/auth/state.ts
+++ b/src/auth/state.ts
@@ -10,4 +10,5 @@ export function build() {
 const a = 1;
-const state = JSON.stringify({ companyId });
+const state = "";
+const b = 2;
 return state;
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,1 @@
-old
+new
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "keep-company-in-state",
  title: "Keep companyId in OAuth state",
  kind: "invariant",
  severity: "blocker",
  paths: ["src/auth/**"],
  sourceComments: ["gh:1"],
  status: "probation",
  body: "The OAuth state must round-trip companyId.",
  ...over,
});

test("glob: ** spans directories, * stays in a segment", () => {
  assert.ok(globToRegExp("src/**").test("src/a/b.ts"));
  assert.ok(globToRegExp("**/migrations/**").test("libs/orm/migrations/001.ts"));
  assert.ok(globToRegExp("**/*.ts").test("a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("src/?.ts").test("src/a.ts"));
  assert.ok(matchesAny("anything", []));
});

test("diff: split, noise filter, commentable HEAD lines", () => {
  assert.deepEqual(changedPaths(DIFF), ["src/auth/state.ts", "package-lock.json", "src/gone.ts"]);
  const { text, dropped } = filterDiff(DIFF);
  assert.deepEqual(dropped, ["package-lock.json"]);
  assert.ok(!text.includes("package-lock"));
  const lines = commentableLines(DIFF).get("src/auth/state.ts")!;
  assert.deepEqual([...lines].sort((a, b) => a - b), [10, 11, 12, 13]);
  assert.equal(commentableLines(DIFF).get("src/gone.ts")?.size, 0);
  assert.equal(splitDiff(DIFF).length, 3);
});

test("diff: truncation keeps every file header", () => {
  const big = DIFF.replace("+const b = 2;", "+" + "x".repeat(5000));
  const { text, dropped } = filterDiff(big, 1500);
  assert.ok(text.includes("diff --git a/src/auth/state.ts"));
  assert.ok(text.includes("diff --git a/src/gone.ts"));
  assert.ok(dropped.some((d) => d.includes("truncated")));
});

test("rules: serialize → parse round-trips, globs quoted", () => {
  const r = rule({ paths: ["**/passport-auth/**"], sourceComments: ["gh:1", "gh-review:2"] });
  const text = serializeRule(r);
  assert.ok(text.includes('  - "**/passport-auth/**"'));
  assert.deepEqual(parseRule(text, r.id), r);
  assert.deepEqual(parseRule(serializeRule(rule({ paths: [] })), r.id).paths, []);
});

test("rules: validation rejects headings and bad ids", () => {
  assert.throws(() => validateRule(rule({ body: "# Policy: x\ntext" })), /heading/);
  assert.throws(() => validateRule(rule({ id: "Bad_Id" })), /kebab/);
  assert.throws(() => parseRule(serializeRule(rule()), "other-stem"), /filename stem/);
});

test("rules: applicable by path, retired excluded", () => {
  const rules = [rule(), rule({ id: "global", paths: [] }), rule({ id: "old", status: "retired", paths: [] })];
  assert.deepEqual(applicableRules(rules, ["src/auth/x.ts"]).map((r) => r.id), ["keep-company-in-state", "global"]);
  assert.deepEqual(applicableRules(rules, ["docs/a.md"]).map((r) => r.id), ["global"]);
});

test("learn ops: create on probation, update appends sources, invalid rejected", () => {
  const base = [rule()];
  const { rules, result } = applyLearnOps(
    base,
    [
      { op: "create", id: "separate-migrations", title: "Migrations ship alone", kind: "convention", severity: "should", paths: ["**/migrations/**"], body: "Ship schema migrations in their own PR.", sourceComments: ["gh:5"] },
      { op: "update", id: "keep-company-in-state", title: null, kind: null, severity: null, paths: null, body: null, sourceComments: ["gh:6"] },
      { op: "update", id: "nope", title: null, kind: null, severity: null, paths: null, body: null, sourceComments: ["gh:6"] },
      { op: "create", id: "no-source", title: "x", kind: "taste", severity: "nit", paths: [], body: "x", sourceComments: ["gh:999"] },
    ],
    new Set(["gh:5", "gh:6"]),
  );
  assert.deepEqual(result.created, ["separate-migrations"]);
  assert.deepEqual(result.updated, ["keep-company-in-state"]);
  assert.equal(result.rejected.length, 2);
  assert.equal(rules.find((r) => r.id === "separate-migrations")!.status, "probation");
  assert.deepEqual(rules.find((r) => r.id === "keep-company-in-state")!.sourceComments, ["gh:1", "gh:6"]);
  assert.deepEqual(result.bySource.get("gh:6"), ["keep-company-in-state"]);
});

test("gating: active rule or high confidence inline; unanchorable → summary; low → drop", () => {
  const ctx = {
    lines: new Map([["a.ts", new Set([10, 11])]]),
    status: new Map<string, Rule["status"]>([["act", "active"], ["prob", "probation"]]),
    threshold: 0.85,
  };
  assert.equal(placeFinding({ path: "a.ts", line: 10, ruleIds: ["act"], confidence: 0.6 }, ctx), "inline");
  assert.equal(placeFinding({ path: "a.ts", line: 10, ruleIds: ["prob"], confidence: 0.6 }, ctx), "summary");
  assert.equal(placeFinding({ path: "a.ts", line: 10, ruleIds: ["prob"], confidence: 0.9 }, ctx), "inline");
  assert.equal(placeFinding({ path: "a.ts", line: 99, ruleIds: ["act"], confidence: 0.99 }, ctx), "summary");
  assert.equal(placeFinding({ path: "a.ts", line: 10, ruleIds: [], confidence: 0.4 }, ctx), "drop");
});

test("stats: promotion and retirement thresholds", () => {
  const s = (reactions: Array<"up" | "down" | null>) =>
    ruleStats({
      schemaVersion: 1,
      comments: Object.fromEntries(reactions.map((reaction, i) => [String(i), { pr: 1, ruleIds: ["r"], reaction, postedAt: "" }])),
    }).get("r");
  assert.equal(proposedStatus(rule({ id: "r" }), s(["up", "up", "up", null])), "active");
  assert.equal(proposedStatus(rule({ id: "r" }), s(["up", "up"])), "probation");
  assert.equal(proposedStatus(rule({ id: "r", status: "active" }), s(["down", "down", "up"])), "retired");
  assert.equal(proposedStatus(rule({ id: "r", status: "retired" }), s(["up", "up", "up"])), "retired");
});

test("marker round-trips rule ids and run id", () => {
  const body = `Fix this.\n\n${marker(["a-b", "c"], "2026-10-04T21-00-00-000Z")}`;
  assert.deepEqual(parseMarker(body), { ruleIds: ["a-b", "c"], runId: "2026-10-04T21-00-00-000Z" });
  assert.deepEqual(parseMarker(marker([], "x1"))?.ruleIds, []);
  assert.equal(parseMarker("plain comment"), null);
});

test("sandbox confinement: paths outside the root are denied", async () => {
  assert.ok(isInside("/tmp/wt", "src/a.ts"));
  assert.ok(isInside("/tmp/wt", "/tmp/wt"));
  assert.ok(!isInside("/tmp/wt", "../x"));
  assert.ok(!isInside("/tmp/wt", "/home/me/.watchtower/truth"));

  const hook = confineTo("/tmp/wt");
  const call = (tool_name: string, tool_input: Record<string, unknown>) =>
    hook(
      { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "/tmp/wt" },
      "t",
      { signal: new AbortController().signal },
    ) as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
  assert.equal((await call("Read", { file_path: "/tmp/wt/src/a.ts" })).hookSpecificOutput, undefined);
  assert.equal((await call("Read", { file_path: "/etc/passwd" })).hookSpecificOutput?.permissionDecision, "deny");
  assert.equal((await call("Grep", { pattern: "companyId", path: "../.." })).hookSpecificOutput?.permissionDecision, "deny");
  assert.equal((await call("Grep", { pattern: "../../anything" })).hookSpecificOutput, undefined);
  assert.equal((await call("Glob", { pattern: "../../**/truth/*" })).hookSpecificOutput?.permissionDecision, "deny");
  assert.equal((await call("Glob", { pattern: "src/**/*.ts" })).hookSpecificOutput, undefined);
});
