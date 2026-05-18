/**
 * Public Weaviate connection settings.
 *
 * NEXT_PUBLIC_* env vars are baked into the static bundle at build time —
 * anyone with the artifact can read them. That is acceptable for this
 * project because (a) the dashboard is served behind Twingate, and
 * (b) the API key has read-only scope. Documented in
 * `.project/01-architecture.md` Section 3C.
 */
export const env = {
  weaviateUrl: process.env.NEXT_PUBLIC_WEAVIATE_URL ?? "",
  weaviateApiKey: process.env.NEXT_PUBLIC_WEAVIATE_API_KEY ?? "",
};

export function envIsConfigured(): boolean {
  return Boolean(env.weaviateUrl);
}
