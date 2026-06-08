/**
 * M7 — structural-skeleton hashing for CHEAP coverage dedup (SPEC §17; OPTIONAL).
 *
 * The coverage crawl is supplementary to the mission list, so its dedup must be
 * cheap and mechanical: two states are "the same" if they're on the same route and
 * share a structural skeleton — the tag/structural-attribute sequence with all TEXT
 * and attribute VALUES dropped. A vision-LLM embedding is reserved for ties only
 * (SPEC §17) and is NOT in this default path.
 *
 * PURE: string-only (regex over serialized HTML; no DOM, no Playwright, no
 * provider). Approximate BY DESIGN — good enough to collapse "same page, different
 * data" without paying for a real DOM. Known, accepted limitations of the regex:
 * a literal "<" inside an attribute VALUE, or rawtext element bodies, can perturb the
 * skeleton; we strip script/style/textarea/noscript bodies to cover the common cases.
 * This is a supplementary dedup, not a verification predicate — over- or
 * under-collapsing a coverage state never affects a mission verdict.
 */

/** Structural attributes kept (by NAME, value dropped) — they shape the skeleton;
 *  everything else (class, style, data values, text) is noise for dedup. */
const STRUCTURAL_ATTRS = ["data-testid", "role", "type", "name", "aria-invalid", "href"];

/**
 * The structural skeleton of a serialized HTML document: the ordered sequence of
 * element tags, each annotated only with which STRUCTURAL attributes are present
 * (never their values). Text content, <script>/<style>, comments, and all other
 * attributes are stripped. Stable across data changes; sensitive to shape changes.
 */
export function structuralSkeleton(html: string): string {
  // drop script/style bodies and comments
  const s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<textarea\b[\s\S]*?<\/textarea>/gi, "<textarea></textarea>")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");

  const tokens: string[] = [];
  // walk every tag in order; ignore the text in between (dedup drops text)
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (closing) {
      tokens.push(`/${tag}`);
      continue;
    }
    const attrsRaw = m[3] ?? "";
    const present = STRUCTURAL_ATTRS.filter((a) => new RegExp(`(^|\\s)${a}(=|\\s|$)`, "i").test(attrsRaw));
    tokens.push(present.length ? `${tag}[${present.join(",")}]` : tag);
  }
  return tokens.join(">");
}

/** Stable, dependency-free 32-bit hash (djb2) rendered as hex. */
export function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A state's cheap dedup key: route + skeleton hash (drop text/values). */
export function stateKey(route: string, html: string): string {
  return `${route}#${hashString(structuralSkeleton(html))}`;
}

/**
 * Dedup states by (route, skeleton) — keep the FIRST occurrence, count the rest.
 * Returns the unique states (input order preserved) and how many were folded.
 */
export function dedupeBySkeleton<T extends { route: string; html: string }>(
  states: T[],
): { unique: T[]; duplicatesFolded: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const st of states) {
    const k = stateKey(st.route, st.html);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(st);
  }
  return { unique, duplicatesFolded: states.length - unique.length };
}
