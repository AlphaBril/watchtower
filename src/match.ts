/**
 * Cheap deterministic prefilter: pairs clone comments with dev comments by
 * file + line proximity and keyword overlap. Its output is only passed to the
 * judge agent as hints ("likely pairs") — the judge makes every call.
 */

// Comments within this many lines (on the same file) are location-compatible.
const LINE_WINDOW = 10;

const STOPWORDS = new Set([
  // English
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "to",
  "of", "in", "on", "at", "is", "are", "be", "this", "that", "it", "you",
  "your", "we", "so", "not", "no", "can", "should", "would", "could", "will",
  "with", "from", "as", "by", "here", "there", "please", "just", "use", "using",
  // French (comments in the target repo are frequently French)
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "on", "ne",
  "pas", "que", "qui", "ce", "cette", "il", "elle", "est", "sont", "dans",
  "pour", "avec", "sur", "sans", "faire", "fera",
]);

export interface Anchored {
  id: string;
  path: string | null;
  line: number | null;
  startLine: number | null;
  body: string;
}

export interface CandidatePair {
  devId: string;
  cloneId: string;
  keywordOverlap: number;
  lineDistance: number | null;
}

function tokenize(body: string): Set<string> {
  const tokens = new Set<string>();
  // Split camelCase / snake_case identifiers so `companyId` also yields
  // `company` and `id`, then keep meaningful word/identifier tokens.
  const normalized = body
    .replace(/[`*_>#|]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  for (const raw of normalized.split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

const effectiveLine = (c: Anchored) => c.startLine ?? c.line;

/** Same-file, nearby-line candidate pairs, best keyword overlap first. */
export function candidatePairs(dev: Anchored[], clone: Anchored[]): CandidatePair[] {
  const devTokens = dev.map((d) => tokenize(d.body));
  const cloneTokens = clone.map((c) => tokenize(c.body));
  const pairs: CandidatePair[] = [];
  dev.forEach((d, di) => {
    clone.forEach((c, ci) => {
      if (d.path === null || d.path !== c.path) return;
      const dl = effectiveLine(d);
      const cl = effectiveLine(c);
      const distance = dl === null || cl === null ? null : Math.abs(dl - cl);
      if (distance !== null && distance > LINE_WINDOW) return;
      pairs.push({
        devId: d.id,
        cloneId: c.id,
        keywordOverlap: Math.round(jaccard(devTokens[di]!, cloneTokens[ci]!) * 100) / 100,
        lineDistance: distance,
      });
    });
  });
  return pairs.sort((a, b) => b.keywordOverlap - a.keywordOverlap);
}
