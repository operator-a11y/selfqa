/**
 * Bounded-concurrency pool (SPEC §9.5).
 *
 * Runs `fn` over `items` with at most `concurrency` in flight, so wall-clock
 * collapses toward the SLOWEST item rather than the sum — the dominant lever on
 * the re-walk budget once per-mission isolation holds (SPEC §9.1).
 *
 * Pure (no Playwright, no provider). A failing item rejects the whole call;
 * callers that want per-item failure isolation should catch inside `fn`.
 */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}
