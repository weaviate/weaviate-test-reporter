import "server-only";

/**
 * Run a route-handler body and return its result as JSON. A thrown error
 * becomes a 500 `{ error }` payload — the client fetch wrapper surfaces
 * `error` to the UI's ErrorState (matching the old graphql() throw behaviour).
 */
// R6: weekly, read-only, user-identical data. On a successful GET response, let
// the browser serve the cached JSON instantly on repeat visits (max-age) and
// serve it while revalidating in the background (stale-while-revalidate) — so a
// repeat visit never waits on the full Weaviate scan again.
const HTTP_FRESH_S = 60;
const HTTP_SWR_S = 3600;

/**
 * Run a route-handler body and return its result as JSON with the right cache
 * policy. Pass `req` so the cache header follows the method: GET/HEAD are
 * idempotent and URL-keyed → safe to cache (SWR); anything else (the Semantic
 * Search POST carries a user query in the body, which HTTP caches ignore since
 * they key POST by URL) → `no-store`. Routes that omit `req` are all GET, so
 * they default to SWR. Errors are never cached.
 */
export async function handle<T>(
  fn: () => Promise<T>,
  req?: Request,
): Promise<Response> {
  try {
    const res = Response.json(await fn());
    const method = req?.method ?? "GET";
    const cacheable = method === "GET" || method === "HEAD";
    res.headers.set(
      "Cache-Control",
      cacheable
        ? `private, max-age=${HTTP_FRESH_S}, stale-while-revalidate=${HTTP_SWR_S}`
        : "no-store",
    );
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Parse an optional integer query param. Returns a finite number, or
 * `undefined` for missing/empty/non-finite input (`"abc"`, `Infinity`, …) so
 * callers fall back to their default rather than propagating `NaN`.
 */
export function parseFiniteInt(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
