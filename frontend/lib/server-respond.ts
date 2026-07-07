import "server-only";

/**
 * Run a route-handler body and return its result as JSON. A thrown error
 * becomes a 500 `{ error }` payload — the client fetch wrapper surfaces
 * `error` to the UI's ErrorState (matching the old graphql() throw behaviour).
 */
// R6: weekly, read-only, user-identical data. On a successful response, let the
// browser serve the cached JSON instantly on repeat visits (max-age) and serve
// it while revalidating in the background (stale-while-revalidate) — so a repeat
// visit never waits on the full Weaviate scan again. POST responses (Semantic
// Search) aren't browser-cached, so those routes are unaffected. Errors are
// never cached.
const HTTP_FRESH_S = 60;
const HTTP_SWR_S = 3600;

export async function handle<T>(fn: () => Promise<T>): Promise<Response> {
  try {
    const res = Response.json(await fn());
    res.headers.set(
      "Cache-Control",
      `private, max-age=${HTTP_FRESH_S}, stale-while-revalidate=${HTTP_SWR_S}`,
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
