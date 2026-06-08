/**
 * Bounded-concurrency pool with STABLE SLOT IDENTITY (SPEC §9.3, §9.5).
 *
 * A FIXED set of `lanes` workers; worker w OWNS slot id `w` for its whole
 * lifetime. Missions are queued onto whichever worker frees up, so `fn` receives
 * `(item, slotId, index)` where `slotId` is the WORKER's lane (stable across the
 * many items that worker pulls) — NOT the item index. That stable lane is what a
 * server/port/DB-file can be bound to (lane w -> server w -> db w), the §9.3
 * precondition for per-mission DB isolation. Results stay ordered by item index.
 *
 * Wall-clock still collapses toward the SLOWEST item rather than the sum (SPEC
 * §9.5). Pure (no Playwright, no provider). A failing item rejects the whole
 * call; callers wanting per-item isolation should catch inside `fn`.
 */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, slotId: number, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));

  async function worker(slotId: number): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], slotId, i);
    }
  }

  await Promise.all(Array.from({ length: lanes }, (_unused, slot) => worker(slot)));
  return results;
}
