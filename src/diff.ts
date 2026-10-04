/**
 * Small unified-diff utilities: split per file, drop noise files, cap size,
 * and compute which HEAD-side lines GitHub will accept an inline comment on.
 */

export interface FileDiff {
  path: string; // HEAD-side path ("b/…"), or the old path for deletions
  text: string; // the full per-file chunk, starting at "diff --git"
}

const NOISE_FILE_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|\.snap$|\.map$|(^|\/)(dist|build|vendor|generated|__generated__)\//;

export function splitDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const text of chunks) {
    const plus = text.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1];
    const header = text.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const path = plus && plus !== "/dev/null" ? plus : (header?.[2] ?? header?.[1] ?? "");
    files.push({ path: path.trim(), text });
  }
  return files;
}

export const isNoiseFile = (path: string) => NOISE_FILE_RE.test(path);

/**
 * Drops lockfiles/generated files and caps the total size, truncating the
 * largest files first so every file keeps at least its header.
 */
export function filterDiff(diff: string, maxChars = 150_000): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const files = splitDiff(diff).filter((f) => {
    if (isNoiseFile(f.path)) dropped.push(f.path);
    return !isNoiseFile(f.path);
  });
  let total = files.reduce((n, f) => n + f.text.length, 0);
  if (total > maxChars) {
    // Mutates the shared FileDiff objects, so `files` keeps its original order.
    const bySize = [...files].sort((a, b) => b.text.length - a.text.length);
    for (const f of bySize) {
      if (total <= maxChars) break;
      const keep = Math.max(400, f.text.length - (total - maxChars));
      if (keep >= f.text.length) continue;
      total -= f.text.length - keep;
      f.text = f.text.slice(0, keep) + `\n… [truncated by watchtower: ${f.path} too large]\n`;
      dropped.push(`${f.path} (truncated)`);
    }
  }
  return { text: files.map((f) => f.text).join(""), dropped };
}

export function changedPaths(diff: string): string[] {
  return splitDiff(diff).map((f) => f.path);
}

/**
 * HEAD-side line numbers that appear in each file's hunks (added + context).
 * GitHub rejects inline review comments outside these lines.
 */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const f of splitDiff(diff)) {
    const lines = new Set<number>();
    let right = 0;
    let inHunk = false;
    for (const l of f.text.split("\n")) {
      const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) {
        right = Number(h[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (l.startsWith("+")) lines.add(right++);
      else if (l.startsWith(" ")) lines.add(right++);
      // "-" lines and "\ No newline" don't advance the HEAD side.
    }
    out.set(f.path, lines);
  }
  return out;
}
