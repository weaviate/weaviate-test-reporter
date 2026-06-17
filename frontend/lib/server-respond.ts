import "server-only";

/**
 * Run a route-handler body and return its result as JSON. A thrown error
 * becomes a 500 `{ error }` payload — the client fetch wrapper surfaces
 * `error` to the UI's ErrorState (matching the old graphql() throw behaviour).
 */
export async function handle<T>(fn: () => Promise<T>): Promise<Response> {
  try {
    return Response.json(await fn());
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
