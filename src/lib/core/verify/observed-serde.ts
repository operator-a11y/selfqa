/**
 * ObservedState <-> SerializedObservedState bridge (M5-A).
 *
 * PURE — imports only checker types; no Playwright, no provider, no node. Safe
 * anywhere. This is what makes a before-state persistable and re-checkable: the
 * re-walk flip comparator (M5-G) runs the SAME checker over the rebuilt state.
 *
 * Round-trip contract: for any selector passed to serialize, rebuild().q(sel)
 * returns the exact stored value (incl. null = could-not-evaluate); for a
 * selector NOT serialized, q() returns { present:false } — identical to the live
 * capture.ts q() for a non-criteria selector, so checkAssertion is lossless.
 */
import type {
  ObservedState,
  ResolvedElement,
  SerializedObservedState,
} from "./checker";

export function serializeObservedState(
  s: ObservedState,
  selectors: string[],
): SerializedObservedState {
  const resolved: Record<string, ResolvedElement | null> = {};
  for (const sel of selectors) resolved[sel] = s.q(sel);
  return {
    url: s.url,
    httpStatus: s.httpStatus,
    consoleErrors: s.consoleErrors,
    formValidationBlocked: s.formValidationBlocked,
    resolved,
  };
}

export function rebuildObservedState(j: SerializedObservedState): ObservedState {
  return {
    url: j.url,
    httpStatus: j.httpStatus,
    consoleErrors: j.consoleErrors,
    formValidationBlocked: j.formValidationBlocked,
    q: (sel: string) =>
      Object.prototype.hasOwnProperty.call(j.resolved, sel)
        ? j.resolved[sel]
        : { present: false, visible: false, text: "" },
  };
}
