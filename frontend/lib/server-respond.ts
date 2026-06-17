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
