/**
 * Touched-routes manifest (SPEC §8.3, §8.4) — PURE: string/array only, no git,
 * no fs, no provider. Consumes diffFiles' string[] (mechanical, never
 * self-reported, P1). v1 = the two-bucket provably-local-else-EVERYTHING rule;
 * the precise import-graph resolver later REPLACES ONLY the shared-file test
 * (§9.5 earned optimization), reusing everything else here.
 */
import type { Mission, MissionTrace } from "../domain/types";

export interface DiffClassification {
  bucket: "everything" | "local";
  routes: string[];
  reason: string;
}

/** Normalize a URL or route into a comparable route path (origin-strip, lowercase, no trailing slash). */
export function normalizeRoute(urlOrRoute: string): string {
  let p = urlOrRoute;
  try {
    p = new URL(urlOrRoute).pathname;
  } catch {
    /* already a path */
  }
  p = p.toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

/**
 * A file is LOCAL only if provably inside a single src/app/<route> own subtree.
 * EVERYTHING else (components/**, lib/**, root app/layout|template|globals,
 * fixtures, prisma, configs, unknown/top-level paths) -> null -> shared. The
 * unmapped path falls to the SAFE side by construction — no discretion.
 */
function localRouteOf(file: string): string | null {
  const m = file.match(/^src\/app\/(.+)$/);
  if (!m) return null; // not under app/ -> shared
  const parts = m[1].split("/");
  const leaf = parts[parts.length - 1];
  const dirSegs = parts.slice(0, -1);
  if (dirSegs.length === 0) {
    // root-level app files: only page is a route ("/"); layout/template/globals are shared
    return /^page\.(tsx|ts|jsx|js)$/.test(leaf) ? "/" : null;
  }
  // a file co-located inside a route subtree -> local to that route
  return "/" + dirSegs.join("/").toLowerCase();
}

export function classifyDiff(changedFiles: string[]): DiffClassification {
  if (changedFiles.length === 0) {
    return { bucket: "local", routes: [], reason: "no files changed" };
  }
  const routes = new Set<string>();
  for (const f of changedFiles) {
    const route = localRouteOf(f);
    if (route === null) {
      return { bucket: "everything", routes: [], reason: `shared/unknown file: ${f}` };
    }
    routes.add(route);
  }
  return { bucket: "local", routes: [...routes], reason: "all files provably route-local" };
}

/** All routes a mission visits (from every step's url; entryRoute as fallback). */
function missionRoutes(trace: MissionTrace | undefined): string[] {
  if (!trace) return [];
  const routes = new Set<string>();
  for (const s of trace.steps) routes.add(normalizeRoute(s.url));
  if (trace.steps.length === 0) routes.add(normalizeRoute(trace.entryRoute));
  return [...routes];
}

/** Segment-wise route match with dynamic-segment ([id]) tolerance + prefix containment. */
function routeMatch(changedRoute: string, visitedRoute: string): boolean {
  if (changedRoute === visitedRoute) return true;
  if (visitedRoute === changedRoute + "/" || visitedRoute.startsWith(changedRoute + "/")) return true;
  const a = changedRoute.split("/");
  const b = visitedRoute.split("/");
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === b[i] || seg.startsWith("[") || b[i].startsWith("["));
}

/** Affected missions (by ALL routes they visit) UNION the always-on smoke set. */
export function selectRewalkSet(
  missions: Mission[],
  traces: Map<string, MissionTrace>,
  cls: DiffClassification,
  smokeIds: string[] = [],
): string[] {
  if (cls.bucket === "everything") return missions.map((m) => m.id);
  const affected = new Set<string>(smokeIds);
  for (const m of missions) {
    const visited = missionRoutes(traces.get(m.id));
    if (visited.some((v) => cls.routes.some((cr) => routeMatch(cr, v)))) {
      affected.add(m.id);
    }
  }
  return [...affected];
}
