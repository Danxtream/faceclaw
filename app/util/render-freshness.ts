/**
 * Per-render-pass channel for stale-data tracking. JS is single-threaded and
 * paints are synchronous, so module state set around a paint is visible to
 * every data source consulted during it, without threading flags through each
 * paint signature.
 *
 * Data sources with a cache (e.g. notification icons) consult
 * renderPassAllowsStaleData() to decide whether to return expired cached data
 * immediately instead of blocking the paint on a refetch, and report having
 * done so via noteStaleDataUsed(). The render loop reads the result from
 * endRenderPass() and schedules one follow-up repaint with fresh data, so the
 * first frame out of sleep is never blocked on slow data sources.
 */

let allowStale = true;
let staleDataUsed = false;

export function beginRenderPass(allowStaleData: boolean): void {
  allowStale = allowStaleData;
  staleDataUsed = false;
}

export function renderPassAllowsStaleData(): boolean {
  return allowStale;
}

export function noteStaleDataUsed(): void {
  staleDataUsed = true;
}

/** End the pass, returning whether any source served stale data. */
export function endRenderPass(): boolean {
  const usedStale = staleDataUsed;
  allowStale = true;
  staleDataUsed = false;
  return usedStale;
}
