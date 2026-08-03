/**
 * Next's file-system cache handler has NO garbage collection: an
 * `unstable_cache` entry is only ever overwritten by a request with the
 * identical key. The day-bucketed keys in `queries.server.ts` therefore
 * strand one set of entry files per day; this selects the ones old enough
 * that no live key can still reference them. Pure — `instrumentation.ts`
 * does the fs walking/unlinking at server start.
 *
 * 2 days, not 1: a generous margin over the 1-day bucket so an entry written
 * just before midnight is never swept while a clock-skewed process could
 * still key into it.
 */
export const CACHE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

export type CacheFileStat = { name: string; mtimeMs: number };

export function staleCacheFiles(
  files: CacheFileStat[],
  nowMs: number,
  maxAgeMs: number = CACHE_MAX_AGE_MS,
): string[] {
  return files.filter((f) => nowMs - f.mtimeMs > maxAgeMs).map((f) => f.name);
}
