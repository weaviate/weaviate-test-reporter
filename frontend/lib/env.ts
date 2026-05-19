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

/**
 * True when the configured `NEXT_PUBLIC_WEAVIATE_URL` hostname looks like
 * a Weaviate Cloud cluster. The Query Agent (api.agents.weaviate.io) is
 * a Cloud-only service — there is no official runtime signal we can
 * probe at /v1/meta to detect it, so the hostname heuristic is the
 * cheapest gate.
 *
 * Falls back to `false` on malformed URLs (the dashboard's main
 * Weaviate client validates the URL at first use; here we just want a
 * safe boolean for hiding the Agent tab).
 */
export function isWeaviateCloudUrl(url: string = env.weaviateUrl): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.endsWith(".weaviate.cloud") || host.endsWith(".weaviate.network")
    );
  } catch {
    return false;
  }
}

/** Agent tab is gated on having BOTH a configured env AND a WCD URL. */
export function agentAvailable(): boolean {
  return envIsConfigured() && isWeaviateCloudUrl();
}
