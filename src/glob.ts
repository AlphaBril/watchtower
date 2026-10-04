/**
 * Minimal glob matching for rule `paths`: `**` (any dirs), `*` (within a
 * segment), `?` (one char). Patterns are repo-relative.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when `globs` is empty (applies everywhere) or any glob matches `path`. */
export function matchesAny(path: string, globs: string[]): boolean {
  return globs.length === 0 || globs.some((g) => globToRegExp(g).test(path));
}
